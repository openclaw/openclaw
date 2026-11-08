/** Tests provider mutations and exec admission through secrets apply. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createApplyFixture,
  createOpenAiProviderConfig,
  createPlan,
  OPENAI_API_KEY_ENV_REF,
  seedDefaultApplyFixture,
  writeJsonFile,
  type ApplyFixture,
} from "./apply.test-support.js";
import type { SecretsApplyPlan } from "./plan.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";

// The admitted apply.test.ts owner installs the shared runtime preflight mock.
const prepareSecretsRuntimeSnapshotMock = vi.mocked(prepareSecretsRuntimeSnapshot);

let runSecretsApply: typeof import("./apply.js").runSecretsApply;
let applyTesting: typeof import("./apply.js").testing;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createOpenAiExecProviderTarget(): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: "models.providers.openai.apiKey",
    providerId: "openai",
    ref: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
  };
}

function createOpenAiExecProviderPlan(): SecretsApplyPlan {
  return createPlan({
    targets: [createOpenAiExecProviderTarget()],
    options: {
      scrubEnv: false,
      scrubAuthProfilesForProviderTargets: false,
      scrubLegacyAuthJson: false,
    },
  });
}

function createPluginProviderPlan(): SecretsApplyPlan {
  return createPlan({
    providerUpserts: {
      vault: {
        source: "exec",
        pluginIntegration: { pluginId: "vault", integrationId: "vault" },
      },
    },
    targets: [],
  });
}

async function writeOpenAiExecResolverConfig(params: {
  fixture: ApplyFixture;
  execScriptPath: string;
  execLogPath?: string;
}): Promise<void> {
  await fs.writeFile(
    params.execScriptPath,
    [
      "#!/bin/sh",
      ...(params.execLogPath ? [`printf 'x\\n' >> ${JSON.stringify(params.execLogPath)}`] : []),
      "cat >/dev/null",
      'printf \'{"protocolVersion":1,"values":{"providers/openai/apiKey":"sk-openai-exec"}}\'', // pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

  await writeJsonFile(params.fixture.configPath, {
    secrets: {
      providers: {
        execmain: {
          source: "exec",
          command: params.execScriptPath,
          jsonOnly: true,
          timeoutMs: 20_000,
          noOutputTimeoutMs: 10_000,
        },
      },
    },
    models: {
      providers: {
        openai: createOpenAiProviderConfig(),
      },
    },
  });
}

function createOpenAiProviderTarget(): SecretsApplyPlan["targets"][number] {
  return {
    type: "models.providers.apiKey",
    path: "models.providers.openai.apiKey",
    providerId: "openai",
    ref: OPENAI_API_KEY_ENV_REF,
  };
}

describe("secrets apply provider plans", () => {
  let fixture: ApplyFixture;

  beforeAll(async () => {
    ({ testing: applyTesting, runSecretsApply } = await import("./apply.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(async () => {
    prepareSecretsRuntimeSnapshotMock.mockClear();
    clearSecretsRuntimeSnapshot();
    fixture = await createApplyFixture(tempDirs.make("openclaw-secrets-apply-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", fixture.configPath);
    await seedDefaultApplyFixture(fixture);
  });

  afterEach(async () => {
    clearSecretsRuntimeSnapshot();
    vi.restoreAllMocks();
    clearRuntimeAuthProfileStoreSnapshots();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("skips exec SecretRef checks during dry-run unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
    await writeOpenAiExecResolverConfig({ fixture, execScriptPath, execLogPath });

    const plan = createOpenAiExecProviderPlan();

    const dryRunSkipped = await runSecretsApply({ plan, env: fixture.env, write: false });
    expect(dryRunSkipped.mode).toBe("dry-run");
    expect(dryRunSkipped.skippedExecRefs).toBe(1);
    expect(dryRunSkipped.checks.resolvabilityComplete).toBe(false);
    await expect(fs.stat(execLogPath)).rejects.toMatchObject({ code: "ENOENT" });

    const dryRunAllowed = await runSecretsApply({
      plan,
      env: fixture.env,
      write: false,
      allowExec: true,
    });
    expect(dryRunAllowed.mode).toBe("dry-run");
    expect(dryRunAllowed.skippedExecRefs).toBe(0);
    const callLog = await fs.readFile(execLogPath, "utf8");
    expect(callLog.split("\n").some((line) => line.trim().length > 0)).toBe(true);
  });

  it("rejects write mode for exec plans unless allowExec is set", async () => {
    const plan = createPlan({
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          providerId: "openai",
          ref: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
        },
      ],
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    await expect(runSecretsApply({ plan, env: fixture.env, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("rejects write mode for plans with exec provider upserts unless allowExec is set", async () => {
    const plan = createPlan({
      targets: [createOpenAiProviderTarget()],
      providerUpserts: {
        execmain: {
          source: "exec",
          command: "/bin/echo",
          args: ["ok"],
        },
      },
      options: {
        scrubEnv: false,
        scrubAuthProfilesForProviderTargets: false,
        scrubLegacyAuthJson: false,
      },
    });

    await expect(runSecretsApply({ plan, env: fixture.env, write: true })).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("applies provider upserts and deletes from plan", async () => {
    await writeJsonFile(fixture.configPath, {
      secrets: {
        providers: {
          envmain: { source: "env" },
          fileold: { source: "file", path: "/tmp/old-secrets.json", mode: "json" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    const plan = createPlan({
      providerUpserts: {
        filemain: {
          source: "file",
          path: "/tmp/new-secrets.json",
          mode: "json",
        },
      },
      providerDeletes: ["fileold"],
      targets: [],
    });

    const nextConfig = await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    });
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      source: "file",
      path: "/tmp/new-secrets.json",
      mode: "json",
    });
  });

  it("enables plugin owners for plugin-managed exec provider upserts", async () => {
    await writeJsonFile(fixture.configPath, {
      plugins: {
        entries: {
          vault: {
            hooks: {
              allowConversationAccess: false,
            },
          },
        },
      },
    });

    const plan = createPluginProviderPlan();

    const nextConfig = await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    });
    expect(nextConfig.plugins?.entries?.vault).toEqual({
      hooks: {
        allowConversationAccess: false,
      },
      enabled: true,
    });
  });

  it.each([
    {
      policy: "plugins are globally disabled",
      plugins: { enabled: false },
      reason: "plugins.enabled is false.",
    },
    {
      policy: "the normalized plugin owner is denied",
      plugins: { deny: ["Vault"] },
      reason: 'plugins.deny includes "vault".',
    },
    {
      policy: "the normalized plugin owner is disabled",
      plugins: { entries: { Vault: { enabled: false } } },
      reason: "plugins.entries.vault.enabled is false.",
    },
    {
      policy: "the plugin is absent from a restrictive allowlist",
      plugins: { allow: ["openai"] },
      reason:
        'plugins.allow does not include "vault". Add the plugin to plugins.allow before applying this plan.',
    },
  ])("rejects plugin-managed exec provider upserts when $policy", async ({ plugins, reason }) => {
    await writeJsonFile(fixture.configPath, { plugins });
    await expect(
      applyTesting.projectConfigForTest({
        plan: createPluginProviderPlan(),
        env: fixture.env,
      }),
    ).rejects.toThrow(`Cannot apply plugin-managed SecretRef provider "vault" because ${reason}`);
  });

  it("preserves normalized restrictive plugin allowlist entries for plugin-managed exec provider upserts", async () => {
    await writeJsonFile(fixture.configPath, {
      plugins: {
        allow: ["Vault"],
      },
    });

    const plan = createPluginProviderPlan();

    const nextConfig = await applyTesting.projectConfigForTest({
      plan,
      env: fixture.env,
    });
    expect(nextConfig.plugins?.allow).toEqual(["Vault"]);
    expect(nextConfig.plugins?.entries?.vault).toEqual({ enabled: true });
  });
});
