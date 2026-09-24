import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { SystemAgentOperationExitError } from "./operations-execution-helpers.js";
import { executeSystemAgentOperation, type SystemAgentCommandDeps } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function prepareConfig(raw = "{}\n") {
  const stateDir = tempDirs.make("openclaw-config-write-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await fs.writeFile(configPath, raw);
  return configPath;
}

describe("createSystemAgentTool.execute config writes", () => {
  it.each([
    ["agents.defaults.models.fixture/primary.agentRuntime.id", "openclaw"],
    ["agents.defaults.model.primary", "fixture/primary"],
    ["models.providers.fixture.baseUrl", "https://example.invalid/v1"],
    ["env.vars.FIXTURE_SETTING", "fixture-value"],
    ["plugins.entries.fixture.enabled", "true"],
  ])("offers approval without writing %s", async (configKey, value) => {
    const configPath = await prepareConfig();
    const result = await createSystemAgentTool({ surface: "cli" }).execute("proposal", {
      action: "config_set",
      path: configKey,
      value,
    });
    expect(result.details).toMatchObject({ needsApproval: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });
});

describe("executeSystemAgentOperation approved config writes", () => {
  it.each([
    {
      configKey: "agents.defaults.models.fixture/primary.agentRuntime.id",
      value: "openclaw",
      saved: {
        agents: {
          defaults: { models: { "fixture/primary": { agentRuntime: { id: "openclaw" } } } },
        },
      },
    },
    {
      configKey: "tools.exec.notifyOnExit",
      value: "false",
      saved: { tools: { exec: { notifyOnExit: false } } },
    },
  ])(
    "saves $configKey through the real writer without a live probe",
    async ({ configKey, value, saved }) => {
      const configPath = await prepareConfig(
        JSON.stringify({ agents: { defaults: { model: { primary: "fixture/primary" } } } }),
      );
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn<
        NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
      >(async () => {
        throw new Error("Unexpected config-write inference probe");
      });
      await expect(
        executeSystemAgentOperation({ kind: "config-set", path: configKey, value }, runtime, {
          approved: true,
          deps: { verifyInferenceConfig },
        }),
      ).resolves.toMatchObject({ applied: true });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject(saved);
      expect(verifyInferenceConfig).not.toHaveBeenCalled();
      expect(lines).toContain("[openclaw] done: config.set");
    },
  );

  it("captures the real schema error and leaves the file unchanged", async () => {
    const raw = JSON.stringify({ gateway: { port: 18789 } });
    const configPath = await prepareConfig(raw);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "gateway.port", value: "banana" },
        runtime,
        { approved: true },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain(
      "gateway.port: Invalid input: expected number, received string",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("keeps the writer's authority check after config validation", async () => {
    const configPath = await prepareConfig();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const beforePersistentApply = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("approving run closed");
      });
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "tools.exec.notifyOnExit", value: "false" },
        runtime,
        { approved: true, beforePersistentApply },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain("approving run closed");
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });

  it.each(["env", "file"] as const)(
    "uses canonical SecretRef validation with an %s provider",
    async (source) => {
      const raw = JSON.stringify({
        secrets: {
          providers: {
            fixture:
              source === "env"
                ? { source }
                : { source, path: "/tmp/unused-fixture-secrets.json", mode: "json" },
          },
        },
      });
      const configPath = await prepareConfig(raw);
      const { runtime, lines } = createSystemAgentTestRuntime();
      const operation = executeSystemAgentOperation(
        {
          kind: "config-set-ref",
          path: "gateway.auth.token",
          source: "env",
          provider: "fixture",
          id: "FIXTURE_API_KEY",
        },
        runtime,
        { approved: true },
      );
      if (source === "env") {
        await expect(operation).resolves.toMatchObject({ applied: true });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          gateway: {
            auth: { token: { source: "env", provider: "fixture", id: "FIXTURE_API_KEY" } },
          },
        });
      } else {
        await expect(operation).rejects.toBeInstanceOf(SystemAgentOperationExitError);
        expect(lines.join("\n")).toContain(
          'provider "fixture" has source "file" but ref requests "env"',
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      }
    },
  );
});
