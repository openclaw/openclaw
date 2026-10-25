import { afterEach, describe, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  collectAuthProfileHealthFindings,
  collectCopilotAmbientTokenFindings,
  collectLegacyCodexProviderOverrideFindings,
  collectSharedAuthStoreFindings,
} from "./doctor-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
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

const oauthConfig = (override: Record<string, unknown>) =>
  doctorFixtureConfig({
    auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
    models: { providers: { "openai-codex": override } },
  });
const copilotEnv = () => ({
  OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-copilot-"),
  GH_TOKEN: "github-test-token",
});
const finding = (value: Record<string, unknown>) => [expect.objectContaining(value)];

describe("doctor auth hints", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
  });

  it("reports ambient GITHUB_TOKEN activation only once", () => {
    const cfg = { plugins: { entries: { "github-copilot": { enabled: true } } } };
    const { GH_TOKEN, ...paths } = copilotEnv();
    const env = { ...paths, GITHUB_TOKEN: GH_TOKEN };
    expect(collectCopilotAmbientTokenFindings(cfg, env)).toEqual(
      finding({
        category: "recommended",
        message: "GitHub Copilot is no longer enabled by GH_TOKEN/GITHUB_TOKEN.",
        fixHint: expect.stringContaining("No action needed if you do not use Copilot"),
      }),
    );
    expect(collectCopilotAmbientTokenFindings(cfg, env)).toEqual([]);
  });

  it.each([
    { models: { providers: { "github-copilot": {} } } },
    { auth: { profiles: { work: { provider: "github-copilot", mode: "token" } } } },
  ])("does not consume the notice for explicit Copilot auth", (config) => {
    const env = copilotEnv();
    expect(collectCopilotAmbientTokenFindings(doctorFixtureConfig(config), env)).toEqual([]);
    expect(
      collectCopilotAmbientTokenFindings(
        {},
        {
          ...env,
          COPILOT_GITHUB_TOKEN: "copilot-test-token",
        },
      ),
    ).toEqual([]);
    expect(collectCopilotAmbientTokenFindings({}, env)).toHaveLength(1);
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
    expect(collectCopilotAmbientTokenFindings(cfg, env)).toEqual([]);
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
    expect(collectSharedAuthStoreFindings(env)).toEqual(
      finding({
        category: "recommended",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    );

    const relocatedEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-doctor-relocated-auth-"),
    };
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: relocatedEnv });
    expect(collectSharedAuthStoreFindings(relocatedEnv)).toEqual([]);
  });

  it("collects legacy Codex override structured findings", async () => {
    const findings = await collectAuthProfileHealthFindings({
      cfg: oauthConfig({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
    });

    expect(findings).toEqual(
      finding({
        checkId: "core/doctor/auth-profiles",
        severity: "warning",
        category: "fix-now",
        fixHint: expect.stringContaining("Remove or rewrite"),
        message:
          "Legacy openai-codex transport override can shadow configured Codex OAuth credentials.",
        path: "models.providers.openai-codex",
        target: "openai-codex",
      }),
    );
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

    const findings = collectLegacyCodexProviderOverrideFindings(
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

    expect(findings).toEqual(
      finding({
        category: "fix-now",
        fixHint: expect.stringContaining("legacy transport override"),
      }),
    );
  });
});
