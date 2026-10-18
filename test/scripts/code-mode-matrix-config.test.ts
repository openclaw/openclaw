import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentExecMatrixConfig,
  createGatewayMatrixConfig,
} from "../../scripts/lib/code-mode-matrix-config.js";
import {
  createGatewayMatrixFixture,
  GATEWAY_MATRIX_TASKS,
} from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import { createGatewayMatrixWorkload } from "../../scripts/lib/code-mode-matrix-gateway.js";
import {
  createMatrixPerformanceFixture,
  isMatrixPerformanceTask,
  MATRIX_PERFORMANCE_TASKS,
} from "../../scripts/lib/code-mode-matrix-performance-fixtures.js";
import { findLegacyConfigIssues } from "../../src/config/legacy.js";
import { validateConfigObjectRaw } from "../../src/config/validation-core.js";

const MODEL = "anthropic/claude-sonnet-5-5";
const ROOT = path.resolve("matrix-fixture");

function expectCurrentConfig(config: unknown) {
  // Validate the serialized payload passed to Gateway, not schema-normalized output.
  const serialized = JSON.stringify(config);
  const written = JSON.parse(serialized);
  const validation = validateConfigObjectRaw(written);
  expect.soft(validation.ok ? [] : validation.issues).toEqual([]);
  expect.soft(findLegacyConfigIssues(written)).toEqual([]);
  return written;
}

describe.each(["direct", "code"] as const)("Gateway matrix %s config", (mode) => {
  it.each([...GATEWAY_MATRIX_TASKS, ...MATRIX_PERFORMANCE_TASKS])(
    "emits canonical %s config and preserves workload controls",
    (task) => {
      const fixture = isMatrixPerformanceTask(task)
        ? createMatrixPerformanceFixture(task, 1)
        : createGatewayMatrixFixture(task, 1);
      const configPatch = "configPatch" in fixture ? fixture.configPatch : undefined;
      const workload = createGatewayMatrixWorkload(task, 1, "low", 180);
      const config = expectCurrentConfig(
        createGatewayMatrixConfig({
          root: ROOT,
          port: 18789,
          token: "synthetic-matrix-test",
          model: MODEL,
          thinking: "low",
          mode,
          executor: "node",
          requiredTools: fixture.requiredTools,
          allowedTools: workload.settings.allowedTools,
          configPatch,
        }),
      );
      expect(config).toMatchObject({
        agents: {
          defaults: {
            model: { primary: MODEL, fallbacks: [] },
            modelPolicy: { allow: [MODEL] },
            fastModeDefault: false,
            thinkingDefault: "low",
            models: {
              [MODEL]: {
                agentRuntime: { id: "openclaw" },
                params: { fastMode: false, thinking: "low" },
              },
            },
          },
        },
        tools: {
          profile: "full",
          allow: workload.settings.allowedTools,
          fs: { workspaceOnly: true },
          exec: { mode: "full" },
          codeMode: { enabled: mode === "code", executor: "node" },
        },
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 18789,
          auth: { mode: "token", token: "synthetic-matrix-test" },
        },
      });
      if (configPatch) {
        expect(config).toMatchObject(configPatch);
      }
    },
  );
});

it("keeps agent-exec model metadata valid without legacy allowlist migration", () => {
  const config = expectCurrentConfig(createAgentExecMatrixConfig(MODEL, "low"));
  expect(config.agents.defaults.modelPolicy).toEqual({ allow: [MODEL] });
  expect(config.agents.defaults.models[MODEL]).toMatchObject({
    agentRuntime: { id: "openclaw" },
    params: { fastMode: false, thinking: "low" },
  });
});

it("enables the selected QuickJS executor without losing the real fixture plugin", () => {
  const fixture = createGatewayMatrixFixture("invoices-auto-retention", 1);
  const workload = createGatewayMatrixWorkload("invoices-auto-retention", 1, "low", 180, "quickjs");
  const config = expectCurrentConfig(
    createGatewayMatrixConfig({
      root: ROOT,
      port: 18789,
      token: "synthetic-matrix-test",
      model: MODEL,
      thinking: "low",
      mode: "code",
      executor: "quickjs",
      requiredTools: fixture.requiredTools,
      allowedTools: workload.settings.allowedTools,
    }),
  );
  expect(config.tools.codeMode).toEqual({ enabled: true, executor: "quickjs" });
  expect(config.plugins.allow).toEqual([
    "anthropic",
    "code-mode-quickjs",
    "code-mode-matrix-fixture",
  ]);
  expect(config.plugins.entries["code-mode-quickjs"]).toEqual({ enabled: true });
  expect(config.plugins.entries["code-mode-matrix-fixture"]).toEqual({
    enabled: true,
    config: { receiptsPath: path.join(ROOT, "receipts.jsonl") },
  });
});
