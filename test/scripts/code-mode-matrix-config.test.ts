import path from "node:path";
import { expect, it } from "vitest";
import {
  createAgentExecMatrixConfig,
  createGatewayMatrixConfig,
} from "../../scripts/lib/code-mode-matrix-config.js";
import { createGatewayMatrixFixture } from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import { createMatrixPerformanceFixture } from "../../scripts/lib/code-mode-matrix-performance-fixtures.js";
import { findLegacyConfigIssues } from "../../src/config/legacy.js";
import { validateConfigObjectRaw } from "../../src/config/validation-core.js";

const MODEL = "anthropic/claude-sonnet-5-5";
const ROOT = path.resolve("matrix-fixture");
function currentConfig(config: unknown) {
  // Exercise the serialized Gateway payload, not a structured clone of undefined properties.
  const serialized = JSON.stringify(config);
  const written = JSON.parse(serialized);
  const validation = validateConfigObjectRaw(written);
  expect.soft(validation.ok ? [] : validation.issues).toEqual([]);
  expect.soft(findLegacyConfigIssues(written)).toEqual([]);
  return written;
}

it.each([
  ["direct", "node", false],
  ["code", "node", true],
  ["code", "quickjs", true],
] as const)("preserves %s/%s config with fixture=%s", (mode, executor, withFixture) => {
  const fixture = withFixture
    ? createMatrixPerformanceFixture("fanout-dependency", 1)
    : createGatewayMatrixFixture("gateway-config-read", 1);
  const configPatch = "configPatch" in fixture ? fixture.configPatch : undefined;
  const allowedTools = ["read", ...fixture.requiredTools];
  const config = currentConfig(
    createGatewayMatrixConfig({
      root: ROOT,
      port: 18789,
      token: "synthetic-matrix-test",
      model: MODEL,
      thinking: "low",
      mode,
      executor,
      requiredTools: fixture.requiredTools,
      allowedTools,
      configPatch,
    }),
  );
  expect(config.tools).toMatchObject({
    profile: "full",
    allow: allowedTools,
    fs: { workspaceOnly: true },
    exec: { mode: "full" },
    codeMode: { enabled: mode === "code", executor },
  });
  expect(config.gateway).toMatchObject({
    mode: "local",
    bind: "loopback",
    port: 18789,
    auth: { mode: "token", token: "synthetic-matrix-test" },
  });
  expect(config.agents.defaults).toMatchObject({
    model: { primary: MODEL, fallbacks: [] },
    modelPolicy: { allow: [MODEL] },
    fastModeDefault: false,
    thinkingDefault: "low",
    models: {
      [MODEL]: { agentRuntime: { id: "openclaw" }, params: { fastMode: false, thinking: "low" } },
    },
  });
  if (configPatch) {
    expect(config).toMatchObject(configPatch);
  }
  expect(config.plugins.allow).toEqual([
    "anthropic",
    ...(executor === "quickjs" ? ["code-mode-quickjs"] : []),
    ...(withFixture ? ["code-mode-matrix-fixture"] : []),
  ]);
  if (withFixture) {
    expect(config.plugins.entries["code-mode-matrix-fixture"]).toEqual({
      enabled: true,
      config: { receiptsPath: path.join(ROOT, "receipts.jsonl") },
    });
  }
  if (executor === "quickjs") {
    expect(config.plugins.entries["code-mode-quickjs"]).toEqual({ enabled: true });
  }
});

it("keeps agent-exec model metadata valid without legacy allowlist migration", () => {
  const config = currentConfig(createAgentExecMatrixConfig(MODEL, "low"));
  expect(config.agents.defaults.modelPolicy).toEqual({ allow: [MODEL] });
  expect(config.agents.defaults.models[MODEL]).toMatchObject({
    agentRuntime: { id: "openclaw" },
    params: { fastMode: false, thinking: "low" },
  });
});
