import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForRuntime: vi.fn<
    typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime
  >(() => {
    throw new Error("unexpected auth profile load");
  }),
  hasAnyAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  hasLocalAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  resolveApiKeyForProfile: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  ...authProfileMocks,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../agents/auth-profiles/doctor.js", () => ({
  formatAuthDoctorHint: vi.fn(async () => "Re-authenticate this profile."),
}));

import { note } from "../../packages/terminal-core/src/note.js";
import { collectAuthProfileHealthFindings, noteAuthProfileHealth } from "./doctor-auth.js";

const noteMock = vi.mocked(note);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const now = 1_700_000_000_000;
let tempDir: string;
let mainDir: string;

function configForAgents(...ids: string[]): OpenClawConfig {
  const entries = Object.fromEntries(
    ids.map((id) => [id, { agentDir: path.join(tempDir, `${id}-agent`) }]),
  );
  return { agents: { entries } };
}

beforeEach(() => {
  tempDir = tempDirs.make("openclaw-doctor-auth-");
  mainDir = path.join(tempDir, "main-agent");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  Object.values(authProfileMocks).forEach((mock) => mock.mockReset());
  authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
  authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(false);
  noteMock.mockReset();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function writeAuthStore(agentDir: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
}

function useLocalStore(store: AuthProfileStore | ((agentDir?: string) => AuthProfileStore)): void {
  authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
    (agentDir) => agentDir !== undefined,
  );
  authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation(
    typeof store === "function" ? store : () => store,
  );
}

async function noteHealth(cfg = configForAgents("main"), accepted = false) {
  const confirmAutoFix = vi.fn(async () => accepted);
  await noteAuthProfileHealth({
    cfg,
    prompter: { confirmAutoFix } as unknown as DoctorPrompter,
    allowKeychainPrompt: false,
  });
  return confirmAutoFix;
}

const findingsForMain = () => collectAuthProfileHealthFindings({ cfg: configForAgents("main") });

function oauthCredential(expires: number, provider = "openai-codex") {
  return { type: "oauth" as const, provider, access: "access", refresh: "refresh", expires };
}

function expiredStore(profileId: string, expires: number): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: oauthCredential(expires) } };
}

it("keeps expiring warnings for static and custom Claude CLI profiles", async () => {
  useLocalStore({
    version: 1,
    profiles: {
      "anthropic:static-cli": {
        type: "token",
        provider: "claude-cli",
        token: "token",
        expires: now + 3 * 60 * 60_000,
      },
      "anthropic:custom-cli": oauthCredential(now + 3 * 60 * 60_000, "claude-cli"),
    },
  });
  expect(await findingsForMain()).toMatchObject([
    { target: "anthropic:custom-cli" },
    { target: "anthropic:static-cli" },
  ]);
});

it.each(["disabled:billing", "cooldown:wham_token_expired"] as const)(
  "maps %s profiles to structured findings with the canonical recovery hint",
  async (kind) => {
    const billing = kind === "disabled:billing";
    const profileId = billing ? "openai:billing" : "openai:expired";
    if (billing) {
      writeAuthStore(mainDir);
    }
    useLocalStore({
      version: 1,
      profiles: billing
        ? {}
        : {
            [profileId]: {
              ...oauthCredential(now + 365 * 24 * 60 * 60_000, "openai"),
              access: "secret",
              refresh: "refresh-secret",
            },
          },
      usageStats: {
        [profileId]: billing
          ? { disabledUntil: now + 5 * 60_000, disabledReason: "billing" }
          : {
              cooldownUntil: now + 5 * 60_000,
              cooldownReason: "auth",
              cooldownClassification: "wham_token_expired",
            },
      },
    });
    const expected = billing
      ? {
          checkId: "core/doctor/auth-profiles",
          message: "Auth profile openai:billing is disabled:billing (5m).",
          path: path.join(mainDir, "openclaw-agent.sqlite"),
          target: "openai:billing",
          fixHint: "Top up credits (provider billing) or switch provider.",
        }
      : {
          message: "Auth profile openai:expired is cooldown:wham_token_expired (5m).",
          fixHint: expect.stringContaining("Re-authenticate with"),
        };
    expect(await findingsForMain()).toMatchObject([expected]);
  },
);
it("skips external auth profile resolution when no auth source exists", async () => {
  await noteAuthProfileHealth({
    cfg: {
      agents: { entries: { main: {} } },
      channels: { telegram: { enabled: true } },
    },
    prompter: {} as DoctorPrompter,
    allowKeychainPrompt: false,
  });

  expect(authProfileMocks.hasAnyAuthProfileStoreSource).toHaveBeenCalledOnce();
  expect(authProfileMocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
});

it("aggregates model auth diagnostics and labels strict agent subsets", async () => {
  const coderDir = path.join(tempDir, "coder-agent");
  writeAuthStore(mainDir);
  writeAuthStore(coderDir);
  useLocalStore((agentDir) => {
    const id = agentDir === mainDir ? "main" : agentDir === coderDir ? "coder" : undefined;
    if (!id) {
      throw new Error(`unexpected agent dir: ${agentDir ?? "<default>"}`);
    }
    return expiredStore(`openai-codex:${id}`, now - 60_000);
  });

  await noteHealth(configForAgents("main", "coder"));

  const modelAuthCalls = noteMock.mock.calls.filter(([, title]) => title === "Model auth");
  expect(modelAuthCalls).toHaveLength(1);
  const body = String(modelAuthCalls[0]?.[0]);
  expect(body).toContain("openai-codex:coder");
  expect(body).toContain("(stores: Agent coder)");
  expect(body).toContain("openai-codex:main");
  expect(body).toContain("(stores: Agent main)");
});

it("offers credential repair while the same profile is cooling down", async () => {
  writeAuthStore(mainDir);
  useLocalStore({
    ...expiredStore("openai-codex:expired", now - 60_000),
    usageStats: { "openai-codex:expired": { cooldownUntil: now + 5 * 60_000 } },
  });
  const confirmAutoFix = await noteHealth();

  expect(confirmAutoFix).toHaveBeenCalledOnce();
  expect(noteMock).toHaveBeenCalledWith(
    expect.stringContaining("openai-codex:expired: cooldown (5m)"),
    "Auth profile cooldowns",
  );
  expect(noteMock).toHaveBeenCalledWith(
    expect.stringContaining("openai-codex:expired: expired"),
    "Model auth",
  );
});

it("prints malformed API-key profile diagnostics", async () => {
  writeAuthStore(mainDir);
  const malformed: AuthProfileStore = {
    version: 1,
    profiles: {
      "zai:default": {
        type: "api_key",
        provider: "zai",
        key: "openclaw onboard --auth-choice zai-coding-global",
      },
    },
  };
  useLocalStore((dir) => (dir === mainDir ? malformed : { version: 1, profiles: {} }));

  await noteHealth();

  expect(noteMock).toHaveBeenCalledWith(
    expect.stringContaining("zai:default: missing [malformed_api_key]"),
    "Model auth",
  );
});

it.each([
  [
    "openai-codex:default",
    "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
    "- openai-codex:default: re-auth required [refresh_token_reused] — Run `openclaw models auth login --provider openai`.",
  ],
  [
    "openai-codex:default",
    "OAuth token refresh failed for openai-codex: temporary upstream issue. Please try again or re-authenticate.",
    "- openai-codex:default: OAuth refresh failed — Try again; if this persists, run `openclaw models auth login --provider openai`.",
  ],
  [
    "OpenAI Work Profile",
    "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
    "- OpenAI Work Profile: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai --profile-id 'OpenAI Work Profile'`.",
  ],
  [
    "openai-codex:default",
    "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
    "- openai-codex:default: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai`.",
  ],
])(
  "formats OAuth refresh failures through the doctor command path",
  async (profileId, message, expected) => {
    useLocalStore(expiredStore(profileId, now - 60_000));
    authProfileMocks.resolveApiKeyForProfile.mockRejectedValue(new Error(message));

    await noteHealth(configForAgents("main"), true);

    expect(noteMock).toHaveBeenCalledWith(expected, "OAuth refresh errors");
  },
);
