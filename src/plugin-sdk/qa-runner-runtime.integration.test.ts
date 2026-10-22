import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as activationCheckRuntime from "./facade-activation-check.runtime.js";
import {
  testing as facadeRuntimeTesting,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { listQaRunnerCliContributions } from "./qa-runner-runtime.js";

const tempDirs = createTempDirTracker();

function resetQaRunnerRuntimeState() {
  resetFacadeRuntimeStateForTest();
  facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(activationCheckRuntime);
}

function writePlugin(
  stateDir: string,
  id: string,
  commandName: string,
  description?: string,
  install = true,
) {
  const pluginDir = path.join(stateDir, "extensions", id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, file), JSON.stringify(value), "utf8");
  write("openclaw.plugin.json", {
    id,
    qaRunners: [{ commandName, ...(description ? { description } : {}) }],
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  write("package.json", {
    name: `@openclaw/${id}`,
    type: "module",
    openclaw: {
      extensions: ["./index.js"],
      ...(install ? { install: { npmSpec: `@openclaw/${id}` } } : {}),
    },
  });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
  return pluginDir;
}

function linkedPlugin(id: string, commandName: string, description?: string) {
  const stateDir = tempDirs.make("openclaw-qa-runner-state-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ plugins: {} }), "utf8");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return writePlugin(stateDir, id, commandName, description);
}

beforeEach(() => {
  resetQaRunnerRuntimeState();
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

afterEach(() => {
  resetQaRunnerRuntimeState();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
});

it("loads an activated qa runner from a linked plugin path without a bundled install fallback", async () => {
  const pluginDir = linkedPlugin("qa-linked", "linked", "Run the linked QA lane");
  fs.writeFileSync(
    path.join(pluginDir, "runtime-api.js"),
    'throw new Error("general runtime surface must not load during QA discovery");\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "qa-runner-api.js"),
    [
      "export const qaRunnerCliRegistrations = [",
      "  {",
      '    commandName: "linked",',
      '    adapterFactory: { id: "linked", matches() { return true; }, async create(context) { return { id: "linked", label: "Linked", accountId: "sut", requiredPluginIds: [], supportedActions: [], async sendInbound(input) { return await context.messages.addInboundMessage(input); }, createGatewayConfig() { return {}; }, async waitReady() {}, buildAgentDelivery({ target }) { return { channel: "linked", to: target, replyChannel: "linked", replyTo: target }; }, async handleAction() {}, createReportNotes() { return []; } }; } },',
      "    register() {}",
      "  }",
      "];",
    ].join("\n"),
    "utf8",
  );

  const contributions = listQaRunnerCliContributions();
  expect(contributions).toEqual([
    {
      pluginId: "qa-linked",
      commandName: "linked",
      description: "Run the linked QA lane",
      status: "available",
      registration: {
        commandName: "linked",
        adapterFactory: expect.objectContaining({
          id: "linked",
        }),
        register: expect.any(Function),
      },
    },
  ]);
});

it("requires linked runners to expose the dedicated QA surface", () => {
  const pluginDir = linkedPlugin("qa-legacy", "legacy");
  fs.writeFileSync(
    path.join(pluginDir, "runtime-api.js"),
    [
      "export const qaRunnerCliRegistrations = [",
      "  {",
      '    commandName: "legacy",',
      "    register() {}",
      "  }",
      "];",
    ].join("\n"),
    "utf8",
  );

  expect(() => listQaRunnerCliContributions()).toThrow(
    "Unable to resolve bundled plugin public surface qa-legacy/qa-runner-api.js",
  );
});

it("ignores operator runner metadata and state during private QA discovery", () => {
  const stateDir = tempDirs.make("openclaw-private-qa-operator-state-");
  const stateDatabasePath = path.join(stateDir, "openclaw.sqlite");
  const stateDatabaseSentinel = "operator-state-must-remain-unopened";

  writePlugin(stateDir, "operator-runner", "operator-sentinel", undefined, false);
  fs.writeFileSync(stateDatabasePath, stateDatabaseSentinel, "utf8");

  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

  const contributions = listQaRunnerCliContributions();

  expect(contributions.some((runner) => runner.pluginId === "operator-runner")).toBe(false);
  expect(fs.readFileSync(stateDatabasePath, "utf8")).toBe(stateDatabaseSentinel);
});
