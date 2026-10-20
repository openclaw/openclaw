import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOAuthRefreshCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
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

const mocks = vi.hoisted(() => ({ ensureAuthProfileStore: vi.fn(), note: vi.fn() }));

// mock-isolation: capture Doctor notes without writing terminal output.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));

function doctorFixtureConfig(config: unknown): OpenClawConfig {
  return config as OpenClawConfig;
}

function copilotEnv(token = "GH_TOKEN") {
  return {
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-copilot-"),
    [token]: "github-test-token",
  };
}

function codexOverrideConfig(override: unknown, configuredAuth = true): OpenClawConfig {
  return doctorFixtureConfig({
    ...(configuredAuth
      ? { auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } } }
      : {}),
    models: { providers: { "openai-codex": override } },
  });
}

function expectNote(text: string, title: string) {
  expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(text), title);
}

describe("doctor auth hints", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
    mocks.note.mockClear();
  });

  it("reports ambient GITHUB_TOKEN activation only once", () => {
    const cfg = { plugins: { entries: { "github-copilot": { enabled: true } } } };
    const env = copilotEnv("GITHUB_TOKEN");
    noteCopilotAmbientToken(cfg, env);
    noteCopilotAmbientToken(cfg, env);
    expect(mocks.note).toHaveBeenCalledExactlyOnceWith(
      "GitHub Copilot is no longer enabled by GH_TOKEN/GITHUB_TOKEN. To use Copilot, run `openclaw models auth login --provider github-copilot` or set COPILOT_GITHUB_TOKEN.",
      "GitHub Copilot",
    );
  });

  it.each([
    { models: { providers: { "github-copilot": {} } } },
    { auth: { profiles: { work: { provider: "github-copilot", mode: "token" } } } },
  ])("does not consume the notice for explicit Copilot auth", (config) => {
    const env = copilotEnv();
    noteCopilotAmbientToken(doctorFixtureConfig(config), env);
    noteCopilotAmbientToken({}, { ...env, COPILOT_GITHUB_TOKEN: "copilot-test-token" });
    expect(mocks.note).not.toHaveBeenCalled();
    noteCopilotAmbientToken({}, env);
    expect(mocks.note).toHaveBeenCalledOnce();
  });

  it("suppresses the notice for a stored shared Copilot profile", () => {
    const env = copilotEnv();
    const cfg: OpenClawConfig = { agents: { entries: { worker: {} } } };
    const agentDir = resolveSharedMainAuthAgentDir(env);
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
      codexOverrideConfig({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
    );

    expectNote("models.providers.openai-codex", "Codex OAuth");
  });

  it("reports the legacy shared auth owner with stored credentials", () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-shared-auth-"),
    };
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "test-key" } },
      },
      resolveSharedMainAuthAgentDir(env),
    );
    noteSharedAuthStoreStatus(env);

    expectNote("openclaw doctor --fix", "Shared auth store");

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
      cfg: codexOverrideConfig({ api: "openai-responses" }),
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
        "openai-codex:default": createOAuthRefreshCredential({ provider: "openai-codex" }),
      },
    });

    noteLegacyCodexProviderOverride(
      codexOverrideConfig({ models: [{ id: "gpt-5.5", api: "openai-responses" }] }, false),
    );

    expectNote("legacy transport override", "Codex OAuth");
  });
});
