// Doctor auth profile-health tests cover stale profile detection, repair notes, and store health.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForRuntime: vi.fn<
    (
      agentDir?: string,
      options?: { allowKeychainPrompt?: boolean; readOnly?: boolean; inheritedAuthDir?: string },
    ) => AuthProfileStore
  >(() => {
    throw new Error("unexpected auth profile load");
  }),
  hasAnyAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  hasLocalAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  resolveApiKeyForProfile: vi.fn(),
  sharedAuthStorePath: undefined as string | undefined,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  loadAuthProfileStoreForRuntime: authProfileMocks.loadAuthProfileStoreForRuntime,
  hasAnyAuthProfileStoreSource: authProfileMocks.hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource: authProfileMocks.hasLocalAuthProfileStoreSource,
  resolveApiKeyForProfile: authProfileMocks.resolveApiKeyForProfile,
}));

vi.mock("../agents/auth-profiles/path-resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles/path-resolve.js")>();
  return {
    ...actual,
    resolveSharedAuthStorePath: () =>
      authProfileMocks.sharedAuthStorePath ?? actual.resolveSharedAuthStorePath(),
  };
});
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../agents/auth-profiles/doctor.js", () => ({
  formatAuthDoctorHint: vi.fn(async () => "Re-authenticate this profile."),
}));

import { note } from "../../packages/terminal-core/src/note.js";
import { collectAuthProfileHealthFindings, noteAuthProfileHealth } from "./doctor-auth.js";

const noteMock = vi.mocked(note);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("noteAuthProfileHealth", () => {
  const now = 1_700_000_000_000;
  let tempDir: string;
  let mainDir: string;

  function configForAgents(...ids: string[]): OpenClawConfig {
    return {
      agents: {
        entries: Object.fromEntries(
          ids.map((id) => [id, { agentDir: path.join(tempDir, `${id}-agent`) }]),
        ),
      },
    };
  }

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-doctor-auth-");
    mainDir = path.join(tempDir, "main-agent");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReset();
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReset();
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReset();
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.resolveApiKeyForProfile.mockReset();
    authProfileMocks.sharedAuthStorePath = undefined;
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

  function useLocalStore(store: AuthProfileStore): void {
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue(store);
  }

  function expectedAuthStorePath(agentDir: string): string {
    return path.join(agentDir, "openclaw-agent.sqlite");
  }

  function expiredStore(profileId: string, expires: number) {
    return {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth" as const,
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires,
        },
      },
    } satisfies AuthProfileStore;
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
        "anthropic:custom-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "access",
          refresh: "refresh",
          expires: now + 3 * 60 * 60_000,
        },
      },
    });

    const findings = await collectAuthProfileHealthFindings({
      cfg: configForAgents("main"),
    });

    expect(findings.map((finding) => finding.target)).toEqual([
      "anthropic:custom-cli",
      "anthropic:static-cli",
    ]);
  });

  it("maps disabled auth profiles to structured findings", async () => {
    writeAuthStore(mainDir);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      version: 1,
      profiles: {},
      usageStats: {
        "openai:billing": {
          disabledUntil: now + 5 * 60_000,
          disabledReason: "billing",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: configForAgents("main"),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        message: "Auth profile openai:billing is disabled:billing (5m).",
        path: expectedAuthStorePath(mainDir),
        target: "openai:billing",
        fixHint:
          "Top up credits (provider billing), then run `openclaw models auth clear-cooldown 'openai:billing' --agent 'main'`, or switch provider.",
      }),
    ]);
  });

  it("targets the shared-main agent for shared state-db recovery commands", async () => {
    // State-db ownership keeps the shared store outside every agent database path.
    authProfileMocks.sharedAuthStorePath = path.join(tempDir, "state", "openclaw.sqlite");
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      version: 1,
      profiles: {},
      usageStats: {
        "openai:billing": { disabledUntil: now + 5 * 60_000, disabledReason: "billing" },
      },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: { agents: { entries: { coder: {}, main: {} } } },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        fixHint: expect.stringContaining("clear-cooldown 'openai:billing' --agent 'main'`"),
      }),
    ]);
  });

  it("shows exact WHAM classification while retaining canonical recovery policy", async () => {
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:expired": {
          type: "oauth",
          provider: "openai",
          access: "secret",
          refresh: "refresh-secret",
          expires: now + 365 * 24 * 60 * 60_000,
        },
      },
      usageStats: {
        "openai:expired": {
          cooldownUntil: now + 5 * 60_000,
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collectAuthProfileHealthFindings({
      cfg: configForAgents("main"),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: "Auth profile openai:expired is cooldown:wham_token_expired (5m).",
        fixHint: expect.stringContaining("Re-authenticate with"),
      }),
    ]);
  });
  it("skips external auth profile resolution when no auth source exists", async () => {
    await noteAuthProfileHealth({
      cfg: {
        agents: { entries: { main: {} } },
        channels: { telegram: { enabled: true } },
      } as OpenClawConfig,
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
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation((agentDir) => {
      if (agentDir === mainDir) {
        return expiredStore("openai-codex:main", now - 60_000);
      }
      if (agentDir === coderDir) {
        return expiredStore("openai-codex:coder", now - 60_000);
      }
      throw new Error(`unexpected agent dir: ${agentDir ?? "<default>"}`);
    });

    await noteAuthProfileHealth({
      cfg: configForAgents("main", "coder"),
      prompter: {
        confirmAutoFix: vi.fn(async () => false),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

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
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      ...expiredStore("openai-codex:expired", now - 60_000),
      usageStats: { "openai-codex:expired": { cooldownUntil: now + 5 * 60_000 } },
    });
    const confirmAutoFix = vi.fn(async () => false);

    await noteAuthProfileHealth({
      cfg: configForAgents("main"),
      prompter: { confirmAutoFix } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

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
    const agentDir = path.join(tempDir, "main-agent");
    writeAuthStore(agentDir);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (candidateDir) => candidateDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation(
      (receivedAgentDir): AuthProfileStore => {
        if (receivedAgentDir === agentDir) {
          return {
            version: 1,
            profiles: {
              "zai:default": {
                type: "api_key",
                provider: "zai",
                key: "openclaw onboard --auth-choice zai-coding-global",
              },
            },
          };
        }
        return { version: 1, profiles: {} };
      },
    );

    await noteAuthProfileHealth({
      cfg: {
        agents: {
          entries: { main: { agentDir } },
        },
      } as OpenClawConfig,
      prompter: {
        confirmAutoFix: vi.fn(async () => false),
      } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

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
      const agentDir = path.join(tempDir, "main-agent");
      authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
        (candidateDir) => candidateDir !== undefined,
      );
      authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue(
        expiredStore(profileId, now - 60_000),
      );
      authProfileMocks.resolveApiKeyForProfile.mockRejectedValue(new Error(message));

      await noteAuthProfileHealth({
        cfg: {
          agents: { entries: { main: { agentDir } } },
        } as OpenClawConfig,
        prompter: { confirmAutoFix: vi.fn(async () => true) } as unknown as DoctorPrompter,
        allowKeychainPrompt: false,
      });

      expect(noteMock).toHaveBeenCalledWith(expected, "OAuth refresh errors");
    },
  );
});
