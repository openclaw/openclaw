import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { createOAuthRefreshCredential as oauth } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { collectAuthProfileHealthFindings, noteAuthProfileHealth } from "./doctor-auth.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
const cliCredentials = vi.hoisted(() => ({ readCodex: vi.fn(), readMiniMax: vi.fn() }));
const refreshProfile = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  resolveApiKeyForProfile: refreshProfile,
}));
vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: cliCredentials.readCodex,
  readMiniMaxCliCredentialsCached: cliCredentials.readMiniMax,
}));

const profileId = "diagnostic-provider:shared";
let state: OpenClawTestState;
let cfg: OpenClawConfig;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-doctor-auth-owners-" });
  cfg = {
    agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    plugins: { enabled: false },
  };
  await state.writeConfig(cfg);
  writeConfigMachineState("auth.sharedStore", { location: "state-db" });
});
afterEach(async () => {
  await state.cleanup();
  vi.clearAllMocks();
  cliCredentials.readCodex.mockReset();
  cliCredentials.readMiniMax.mockReset();
});

function save(profile: ReturnType<typeof oauth>, agentDir?: string) {
  writePersistedAuthProfileStoreRaw({ version: 1, profiles: { [profileId]: profile } }, agentDir);
}

function finding(path: string, message: string, extra = {}) {
  return expect.objectContaining({
    target: profileId,
    path,
    message: expect.stringContaining(message),
    ...extra,
  });
}

function reportHealth(repair = false) {
  return noteAuthProfileHealth({
    cfg,
    prompter: createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true, repair },
    }),
    allowKeychainPrompt: false,
  });
}

describe("Doctor shared auth health", () => {
  it("keeps inherited-profile recovery guidance local without duplicating shared expiry", async () => {
    save(oauth({ provider: "diagnostic-provider", expires: Date.now() - 60_000 }));
    const agentDir = state.agentDir("alpha");
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
    const cooldown = { cooldownUntil: Date.now() + 600_000, cooldownReason: "session_expired" };
    writePersistedAuthProfileStateRaw(
      { version: 1, usageStats: { [profileId]: cooldown } },
      agentDir,
    );
    const fixHint =
      "Re-authenticate with `openclaw models auth login --provider diagnostic-provider --profile-id 'diagnostic-provider:shared'`.";

    const findings = await collectAuthProfileHealthFindings({ cfg });
    expect(refreshProfile).not.toHaveBeenCalled();
    expect
      .soft(findings)
      .toEqual([
        finding(resolveSharedAuthStorePath(), "expired"),
        finding(resolveAuthProfileDatabasePath(agentDir), "cooldown:session_expired", { fixHint }),
      ]);
    await reportHealth();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining(fixHint),
      "Auth profile cooldowns (Agent alpha)",
    );
  });

  it("reports a missing host profile without importing the native Codex account", async () => {
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: { "openai:default": { type: "oauth", provider: "openai", expires: 1 } },
      },
      state.agentDir("alpha"),
    );
    cliCredentials.readCodex.mockReturnValue(oauth({ expires: Date.now() + 7 * 86_400_000 }));

    expect(await collectAuthProfileHealthFindings({ cfg })).toEqual([
      expect.objectContaining({
        target: "openai:default",
        requirement: "missing_credential",
        fixHint: expect.stringContaining("openclaw models auth login --provider openai"),
      }),
    ]);
    expect(cliCredentials.readCodex).not.toHaveBeenCalled();
  });

  it.each([
    { name: "healthy shared", sharedExpired: false, sameAccount: true, owner: undefined },
    { name: "expired shared", sharedExpired: true, sameAccount: true, owner: "shared" },
    { name: "distinct local account", sharedExpired: false, sameAccount: false, owner: "local" },
  ])("respects canonical OAuth ownership for $name credentials", async (scenario) => {
    const shared = oauth({
      provider: "diagnostic-provider",
      access: "synthetic-shared-access",
      refresh: "synthetic-shared-refresh",
      accountId: "shared-account",
      expires: Date.now() + (scenario.sharedExpired ? -60_000 : 7 * 86_400_000),
    });
    const local = {
      ...shared,
      access: "synthetic-old-local-access",
      refresh: "synthetic-old-local-refresh",
      accountId: scenario.sameAccount ? shared.accountId : "local-account",
      expires: Date.now() - 120_000,
    };
    const agentDir = state.agentDir("alpha");
    save(shared);
    save(local, agentDir);

    expect(loadAuthProfileStoreForRuntime(agentDir).profiles[profileId]).toEqual(local);
    expect(resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId })).toBe(
      scenario.sameAccount ? undefined : agentDir,
    );
    const ownerDir = scenario.owner === "shared" ? undefined : agentDir;
    const ownerPath = ownerDir
      ? resolveAuthProfileDatabasePath(ownerDir)
      : resolveSharedAuthStorePath();
    expect
      .soft(await collectAuthProfileHealthFindings({ cfg }))
      .toEqual(scenario.owner ? [finding(ownerPath, "expired")] : []);
    await reportHealth(true);
    expect(refreshProfile.mock.calls).toEqual(
      scenario.owner
        ? [[expect.objectContaining({ profileId, agentDir: ownerDir, forceRefresh: true })]]
        : [],
    );
  });
});
