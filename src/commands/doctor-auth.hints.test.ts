// Doctor auth hint tests cover OAuth refresh failure formatting and auth repair guidance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  collectAuthProfileHealthFindings,
  noteCopilotAmbientToken,
  noteLegacyCodexProviderOverride,
  noteSharedAuthStoreStatus,
} from "./doctor-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  };
});

function doctorFixtureConfig(config: unknown): OpenClawConfig {
  return config as OpenClawConfig;
}

describe("doctor auth hints", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
    mocks.note.mockClear();
  });

  it.each([
    { key: "GH_TOKEN", cfg: {} },
    { key: "GITHUB_TOKEN", cfg: { plugins: { entries: { "github-copilot": { enabled: true } } } } },
  ])("reports ambient $key activation only once", ({ key, cfg }) => {
    const env = {
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-copilot-"),
      [key]: "github-test-token",
    };
    noteCopilotAmbientToken(cfg, env);
    noteCopilotAmbientToken(cfg, env);
    expect(mocks.note).toHaveBeenCalledExactlyOnceWith(
      "GitHub Copilot is no longer enabled by GH_TOKEN/GITHUB_TOKEN. To use Copilot, run `openclaw models auth login --provider github-copilot` or set COPILOT_GITHUB_TOKEN.",
      "GitHub Copilot",
    );
  });

  it.each([
    {},
    { models: { providers: { "github-copilot": {} } } },
    { auth: { profiles: { work: { provider: "github-copilot", mode: "token" } } } },
  ])("does not consume the notice for absent ambient auth or explicit Copilot", (config) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-copilot-") };
    noteCopilotAmbientToken(doctorFixtureConfig(config), {
      ...env,
      ...(Object.keys(config).length ? { GH_TOKEN: "github-test-token" } : {}),
    });
    noteCopilotAmbientToken(
      {},
      {
        ...env,
        GH_TOKEN: "github-test-token",
        COPILOT_GITHUB_TOKEN: "copilot-test-token",
      },
    );
    expect(mocks.note).not.toHaveBeenCalled();
    noteCopilotAmbientToken({}, { ...env, GH_TOKEN: "github-test-token" });
    expect(mocks.note).toHaveBeenCalledOnce();
  });

  it.each(["shared", "agent"])("suppresses the notice for a stored %s Copilot profile", (owner) => {
    const env = {
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-copilot-"),
      GH_TOKEN: "github-test-token",
    };
    const cfg: OpenClawConfig = { agents: { entries: { worker: {} } } };
    const agentDir =
      owner === "shared" ? resolveSharedMainAuthAgentDir(env) : resolveAgentDir(cfg, "worker", env);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          work: { type: "token", provider: "github-copilot", token: "copilot-test-token" },
        },
      },
      agentDir,
    );
    noteCopilotAmbientToken(cfg, env);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("warns when a legacy Codex override shadows canonical OpenAI OAuth config", () => {
    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("models.providers.openai-codex"),
      "Codex OAuth",
    );
  });

  it("does not report a legacy shared auth owner without stored credentials", () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-shared-auth-"),
    };
    noteSharedAuthStoreStatus(env);

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("reports the legacy shared auth owner with stored credentials", () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-shared-auth-"),
    };
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "test-key" },
        },
      },
      resolveSharedMainAuthAgentDir(env),
    );
    noteSharedAuthStoreStatus(env);

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw doctor --fix"),
      "Shared auth store",
    );

    mocks.note.mockClear();
    const relocatedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-relocated-auth-"),
    };
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: relocatedEnv });
    noteSharedAuthStoreStatus(relocatedEnv);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("collects legacy Codex override structured findings", async () => {
    const findings = await collectAuthProfileHealthFindings({
      cfg: doctorFixtureConfig({
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
            },
          },
        },
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        message:
          "Legacy openai-codex transport override can shadow configured Codex OAuth credentials.",
        path: "models.providers.openai-codex",
        target: "openai-codex",
      }),
    ]);
  });

  it("warns when a legacy Codex override shadows stored legacy OAuth state", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });

    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.5", api: "openai-responses" }],
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("legacy transport override"),
      "Codex OAuth",
    );
  });
});
