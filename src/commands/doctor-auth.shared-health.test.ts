import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthRefreshCredential as oauth } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  collectAuthProfileHealthFindings,
  inspectAuthProfileHealth,
  collectCopilotAmbientTokenFindings,
  collectLegacyCodexProviderOverrideFindings,
  collectSharedAuthStoreFindings,
} from "./doctor-auth.js";
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

afterEach(() => {
  vi.clearAllMocks();
  refreshProfile.mockReset();
  cliCredentials.readCodex.mockReset();
  cliCredentials.readMiniMax.mockReset();
});

function withFleet(
  run: (state: OpenClawTestState, cfg: OpenClawConfig) => Promise<void>,
  relocated = true,
) {
  return withOpenClawTestState({ prefix: "openclaw-doctor-auth-" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    if (relocated) {
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
    }
    await run(state, cfg);
  });
}
function profiles(value: AuthProfileStore["profiles"], dir?: string) {
  writePersistedAuthProfileStoreRaw({ version: 1, profiles: value }, dir);
}
function doctorFixtureConfig(config: unknown): OpenClawConfig {
  return config as OpenClawConfig;
}
const profileId = "diagnostic-provider:shared";
const recoveryHint =
  "Re-authenticate with `openclaw models auth login --provider diagnostic-provider --profile-id 'diagnostic-provider:shared'`.";
const inspect = (cfg: OpenClawConfig, repair = false) =>
  inspectAuthProfileHealth({
    cfg,
    prompter: createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true, repair },
    }),
    allowKeychainPrompt: false,
  });

describe("Doctor shared auth health", () => {
  it("keeps inherited-profile recovery guidance local without duplicating shared expiry", async () => {
    await withFleet(async (state, cfg) => {
      profiles({
        [profileId]: oauth({ provider: "diagnostic-provider", expires: Date.now() - 60_000 }),
      });
      const agentDir = state.agentDir("alpha");
      profiles({}, agentDir);
      writePersistedAuthProfileStateRaw(
        {
          version: 1,
          usageStats: {
            [profileId]: { cooldownUntil: Date.now() + 600_000, cooldownReason: "session_expired" },
          },
        },
        agentDir,
      );

      const findings = await collectAuthProfileHealthFindings({ cfg });
      expect(refreshProfile).not.toHaveBeenCalled();
      expect.soft(findings).toEqual([
        expect.objectContaining({
          target: profileId,
          path: resolveSharedAuthStorePath(),
          message: expect.stringContaining("expired"),
        }),
        expect.objectContaining({
          target: profileId,
          path: resolveAuthProfileDatabasePath(agentDir),
          message: expect.stringContaining("cooldown:session_expired"),
          fixHint: recoveryHint,
        }),
      ]);
      const currentFindings = await inspect(cfg);
      expect(currentFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: profileId,
            category: "fix-now",
            path: resolveAuthProfileDatabasePath(agentDir),
            fixHint: recoveryHint,
          }),
        ]),
      );
    });
  });

  it("reports a missing host profile without importing the native Codex account", async () => {
    await withFleet(async (state, cfg) => {
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
  });

  it.each([
    { name: "healthy shared", sharedExpired: false, sameAccount: true, owner: undefined },
    { name: "expired shared", sharedExpired: true, sameAccount: true, owner: "shared" },
    { name: "distinct local account", sharedExpired: false, sameAccount: false, owner: "local" },
  ])("respects canonical OAuth ownership for $name credentials", async (scenario) => {
    await withFleet(async (state, cfg) => {
      const shared = oauth({
        provider: "diagnostic-provider",
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
      profiles({ [profileId]: shared });
      profiles({ [profileId]: local }, agentDir);

      const findings = await collectAuthProfileHealthFindings({ cfg });
      expect.soft(findings).toEqual(
        scenario.owner
          ? [
              expect.objectContaining({
                target: profileId,
                path:
                  scenario.owner === "shared"
                    ? resolveSharedAuthStorePath()
                    : resolveAuthProfileDatabasePath(agentDir),
                message: expect.stringContaining("expired"),
              }),
            ]
          : [],
      );
      if (scenario.owner) {
        refreshProfile.mockImplementationOnce(async () => {
          profiles(
            { [profileId]: { ...shared, expires: Date.now() + 7 * 86_400_000 } },
            scenario.owner === "local" ? agentDir : undefined,
          );
        });
      }
      expect(await inspect(cfg, true)).toEqual([]);
      expect(refreshProfile).toHaveBeenCalledTimes(scenario.owner ? 1 : 0);
      if (scenario.owner) {
        expect(refreshProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId,
            agentDir: scenario.owner === "shared" ? undefined : agentDir,
            forceRefresh: true,
          }),
        );
      }
    });
  });
});

it("reports ambient Copilot activation once", async () => {
  await withFleet(async (state) => {
    const env = { ...state.env, GITHUB_TOKEN: "github-test-token" };
    expect(collectCopilotAmbientTokenFindings({}, env)).toEqual([
      expect.objectContaining({
        category: "recommended",
        fixHint: expect.stringContaining("No action needed if you do not use Copilot"),
      }),
    ]);
    expect(collectCopilotAmbientTokenFindings({}, env)).toEqual([]);
  });
});

it.each(["provider", "profile", "token", "stored"] as const)(
  "does not consume the ambient notice for explicit Copilot %s",
  async (kind) => {
    await withFleet(async (state) => {
      const env = { ...state.env, GH_TOKEN: "github-test-token" };
      const cfg = doctorFixtureConfig(
        kind === "provider"
          ? { models: { providers: { "github-copilot": {} } } }
          : kind === "profile"
            ? { auth: { profiles: { work: { provider: "github-copilot", mode: "token" } } } }
            : {},
      );
      if (kind === "stored") {
        profiles({
          work: { type: "token", provider: "github-copilot", token: "copilot-test-token" },
        });
      }
      expect(
        collectCopilotAmbientTokenFindings(cfg, {
          ...env,
          ...(kind === "token" ? { COPILOT_GITHUB_TOKEN: "copilot-test-token" } : {}),
        }),
      ).toEqual([]);
      if (kind !== "stored") {
        expect(collectCopilotAmbientTokenFindings({}, env)).toHaveLength(1);
      }
    });
  },
);

it("reports legacy shared auth until its owner is relocated", async () => {
  await withFleet(async (state) => {
    profiles(
      { "openai:default": { type: "api_key", provider: "openai", key: "test-key" } },
      resolveSharedMainAuthAgentDir(state.env),
    );
    expect(collectSharedAuthStoreFindings(state.env)).toEqual([
      expect.objectContaining({
        category: "recommended",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.statePath("relocated") };
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    expect(collectSharedAuthStoreFindings(env)).toEqual([]);
  }, false);
});

it.each([false, true])("warns about legacy Codex overrides (stored OAuth: %s)", async (stored) => {
  await withFleet(async () => {
    if (stored) {
      profiles({
        "openai-codex:default": oauth({ provider: "openai-codex" }),
      });
    }
    const cfg = doctorFixtureConfig({
      ...(!stored
        ? { auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } } }
        : {}),
      models: {
        providers: {
          "openai-codex": stored
            ? { models: [{ id: "gpt-5.5", api: "openai-responses" }] }
            : { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
        },
      },
    });
    const findings = stored
      ? collectLegacyCodexProviderOverrideFindings(cfg)
      : await collectAuthProfileHealthFindings({ cfg });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        category: "fix-now",
        path: "models.providers.openai-codex",
        target: "openai-codex",
        fixHint: expect.stringContaining("Remove or rewrite"),
      }),
    ]);
  });
});
