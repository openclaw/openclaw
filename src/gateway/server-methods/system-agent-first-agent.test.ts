import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";

// The verified connection/application receipt is the input to this boundary.
// Config reads and workspace inspection remain real.
vi.mock("../../system-agent/setup-inference.js", async (original) => {
  const actual = await original<typeof import("../../system-agent/setup-inference.js")>();
  return {
    ...actual,
    activateSetupInference: vi.fn<typeof actual.activateSetupInference>(async (params) => {
      params.onActivationCompletion?.(async () => false);
      return {
        ok: true,
        modelRef: "fixture/model",
        latencyMs: 1,
        lines: [],
        ...(params.modelTarget ? { modelTarget: params.modelTarget } : {}),
      };
    }),
  };
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it.each([
  { name: "an implicit main", expected: { agentId: "main", bootstrapPending: false } },
  {
    name: "a pending bootstrap",
    bootstrap: true,
    expected: { agentId: "main", bootstrapPending: true },
  },
  {
    name: "an authored agent",
    roster: true,
    expected: { agentId: "helper", bootstrapPending: false },
  },
  { name: "utility-only setup", utility: true },
  { name: "an unknown requested agent", agentId: "missing" },
  { name: "an unreadable config", corrupt: true },
])("describes $name after successful setup without writing or failing", async (scenario) => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspace = path.join(home, "workspace");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      scenario.corrupt
        ? "{ not json"
        : JSON.stringify({
            gateway: { mode: "local", auth: { mode: "token", token: "synthetic-test-token" } },
            plugins: { slots: { memory: "none" } },
            agents: {
              defaults: { workspace, model: "fixture/model" },
              ...(scenario.roster ? { entries: { helper: { workspace } } } : {}),
            },
          }),
    );
    if (scenario.bootstrap) {
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "BOOTSTRAP.md"), "Get acquainted.\n");
    }
    resetConfigRuntimeState();
    const before = await fs.readFile(configPath, "utf8");

    const result = await activateGatewaySetupInference({
      kind: "existing-model",
      surface: "gateway",
      runtime: defaultRuntime,
      ...(scenario.agentId ? { agentId: scenario.agentId } : {}),
      ...(scenario.utility ? { modelTarget: "utility" as const } : {}),
    });

    expect(result.ok).toBe(true);
    if (scenario.expected) {
      expect(result).toMatchObject({
        firstAgent: {
          ...scenario.expected,
          sessionKey: `agent:${scenario.expected.agentId}:main`,
        },
      });
    } else {
      expect(result).not.toHaveProperty("firstAgent");
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
    if (!scenario.bootstrap) {
      await expect(fs.stat(path.join(workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
