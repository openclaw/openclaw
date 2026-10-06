import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginProcessRuntimeEntrypoints } from "../plugins/process-runtime.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupStartupPluginSourceCaptures } from "./startup-plugin-source-captures.js";

it("keeps an inspected native image outside Doctor's disposable database snapshot", async () => {
  await withOpenClawTestState(
    {
      label: "doctor-native-capture",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    },
    async (state) => {
      const plugin = state.path("native-plugin");
      fs.mkdirSync(plugin);
      const require = createRequire(import.meta.url);
      const koffi = createRequire(require.resolve("koffi"));
      const nativePackage = path.dirname(
        koffi.resolve(`@koromix/koffi-${process.platform}-${process.arch}`),
      );
      fs.copyFileSync(
        path.join(nativePackage, `${process.platform}_${process.arch}`, "koffi.node"),
        path.join(plugin, "koffi.node"),
      );
      fs.writeFileSync(path.join(plugin, "companion.txt"), "retained native companion");
      fs.writeFileSync(
        path.join(plugin, "package.json"),
        JSON.stringify({
          name: "native-capture-proof",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(plugin, "openclaw.plugin.json"),
        JSON.stringify({
          id: "native-capture-proof",
          contracts: { tools: ["capture_probe"] },
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      fs.writeFileSync(
        path.join(plugin, "index.cjs"),
        `
const fs = require("node:fs");
const path = require("node:path");
const image = fs.realpathSync(require.resolve("./koffi.node"));
const addon = require("./koffi.node");
globalThis[Symbol.for("doctor-native-capture-proof")] = {
  addon, image, privateStateDir: process.env.OPENCLAW_STATE_DIR,
  companion: path.join(path.dirname(image), "companion.txt"),
};
module.exports = { id: "native-capture-proof", register(api) {
  api.registerTool({ name: "capture_probe", label: "Capture probe", description: "Synthetic capture probe",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
  }, { name: "capture_probe" });
} };
`,
      );
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" }, model: "fixture/local" },
          entries: { main: { workspace: state.workspaceDir, tools: { allow: ["capture_probe"] } } },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              models: [
                {
                  id: "local",
                  name: "Local fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
        plugins: {
          allow: ["native-capture-proof"],
          load: { paths: [plugin] },
          slots: { memory: "none" },
        },
        memory: { search: { enabled: false } },
      });
      const database = openOpenClawStateDatabase();
      const databasePath = database.path;
      await closeOpenClawStateDatabaseAsync();
      const before = fs.readFileSync(databasePath);
      const entry = resolveRuntimeWorkerUrl(
        pluginProcessRuntimeEntrypoints.doctorLintNativeCapture,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
          ...resolveRuntimeWorkerArgv(entry),
          state.path("nested-state"),
        ],
        {
          env: state.env,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const receipt = result.stdout.split("\n").find((line) => line.startsWith("CAPTURE_PROOF:"));
      expect(receipt).toBeDefined();
      const observed: Array<{ image: string; companion: string }> = JSON.parse(
        receipt!.slice("CAPTURE_PROOF:".length),
      );
      expect(observed).toHaveLength(2);
      expect(fs.readFileSync(databasePath)).toEqual(before);
      expect(observed.every(({ image }) => fs.existsSync(image))).toBe(true);
      await cleanupStartupPluginSourceCaptures(state.env);
      for (const { image, companion } of observed) {
        expect(fs.existsSync(image)).toBe(false);
        expect(fs.existsSync(companion)).toBe(false);
      }
    },
  );
});
