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
let stateDir: string;

function resetQaRunnerRuntimeState() {
  resetFacadeRuntimeStateForTest();
  facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(activationCheckRuntime);
}

function writePlugin(id: string, commandName: string, description?: string, install = true) {
  const pluginDir = path.join(stateDir, "extensions", id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(
      path.join(pluginDir, file),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
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
  write("index.js", "export default {};\n");
  return write;
}

beforeEach(() => {
  resetQaRunnerRuntimeState();
  stateDir = tempDirs.make("openclaw-qa-runner-state-");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), '{"plugins":{}}', "utf8");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

afterEach(() => {
  resetQaRunnerRuntimeState();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
});

it("loads an activated qa runner from a linked plugin path without a bundled install fallback", async () => {
  const write = writePlugin("qa-linked", "linked", "Run the linked QA lane");
  write(
    "runtime-api.js",
    'throw new Error("general runtime surface must not load during QA discovery");\n',
  );
  write(
    "qa-runner-api.js",
    'export const qaRunnerCliRegistrations = [{ commandName: "linked", register() {}, adapterFactory: { id: "linked", matches() { return true; }, async create() {} } }];',
  );

  expect(listQaRunnerCliContributions()).toEqual([
    {
      pluginId: "qa-linked",
      commandName: "linked",
      description: "Run the linked QA lane",
      status: "available",
      registration: {
        commandName: "linked",
        adapterFactory: expect.objectContaining({ id: "linked" }),
        register: expect.any(Function),
      },
    },
  ]);
});

it("requires linked runners to expose the dedicated QA surface", () => {
  const write = writePlugin("qa-legacy", "legacy");
  write(
    "runtime-api.js",
    'export const qaRunnerCliRegistrations = [{ commandName: "legacy", register() {} }];',
  );

  expect(() => listQaRunnerCliContributions()).toThrow(
    "Unable to resolve bundled plugin public surface qa-legacy/qa-runner-api.js",
  );
});

it("ignores operator runner metadata and state during private QA discovery", () => {
  const stateDatabasePath = path.join(stateDir, "openclaw.sqlite");
  const stateDatabaseSentinel = "operator-state-must-remain-unopened";

  writePlugin("operator-runner", "operator-sentinel", undefined, false);
  fs.writeFileSync(stateDatabasePath, stateDatabaseSentinel, "utf8");

  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");

  const contributions = listQaRunnerCliContributions();

  expect(contributions.some((runner) => runner.pluginId === "operator-runner")).toBe(false);
  expect(fs.readFileSync(stateDatabasePath, "utf8")).toBe(stateDatabaseSentinel);
});
