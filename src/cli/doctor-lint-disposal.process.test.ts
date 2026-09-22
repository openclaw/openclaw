import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const fixtures = createFixtureLifetime();
afterEach(() => fixtures.cleanup());

it.each(["release", "timeout"])(
  "reports real plugin checks before disposal, then joins the worker (%s)",
  async (mode) => {
    await fixtures.run(async () => {
      const root = fixtures.createTempDir("doctor-lint-disposal-");
      const plugin = path.join(root, "plugin");
      const release = path.join(root, "release-disposal");
      const observation = path.join(root, "disposal.json");
      fs.mkdirSync(plugin);
      fs.mkdirSync(path.join(root, "workspace"));
      fs.writeFileSync(
        path.join(plugin, "package.json"),
        JSON.stringify({
          name: "disposal-proof",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(plugin, "openclaw.plugin.json"),
        JSON.stringify({
          id: "disposal-proof",
          contracts: { tools: ["disposal_probe"] },
          configSchema: { type: "object", properties: {}, additionalProperties: false },
        }),
      );
      fs.writeFileSync(
        path.join(plugin, "index.cjs"),
        `const fs = require("node:fs");
module.exports = { id: "disposal-proof", register(api) {
  api.lifecycle.registerRuntimeLifecycle({ id: "retirement", async dispose() {
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({pid: process.pid, stateDir: process.env.OPENCLAW_STATE_DIR}));
    process.stderr.write("fixture disposal entered\\n");
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
  }});
  api.registerTool(() => ({ name: "disposal_probe", label: "Disposal probe", description: "Synthetic disposal proof",
    parameters: {type: "object", properties: {}}, execute: async () => ({content: []}) }), {name: "disposal_probe"});
}};
`,
      );
      const configPath = path.join(root, "openclaw.json");
      const config = JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" }, model: "fixture/local" },
          entries: {
            main: { workspace: path.join(root, "workspace"), tools: { allow: ["disposal_probe"] } },
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              models: [
                {
                  id: "local",
                  name: "Synthetic local model",
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
          allow: ["disposal-proof"],
          load: { paths: [plugin] },
          slots: { memory: "none" },
        },
      });
      fs.writeFileSync(configPath, config);
      const doctorHealth = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.doctorHealth);
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...buildUpdateRehearsalPathEnv(root),
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
        }),
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
        OPENCLAW_NO_RESPAWN: "1",
        // The Doctor API must share the selected child generation, including its SDK.
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(path.dirname(fileURLToPath(doctorHealth))),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "1",
        NO_COLOR: "1",
      };
      const report = createDeferredCore<unknown>();
      const cli = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
      const cliArgs = [
        ...resolveRuntimeWorkerArgv(cli),
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
        "--only",
        "core/doctor/runtime-tool-schemas",
      ];
      let nodeArgs = cliArgs;
      if (mode === "timeout") {
        const supervisor = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.doctorLintSupervisor);
        const signals = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.signalExitBarrier);
        const output = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.outputDrain);
        const harness = path.join(root, "supervise-lint.mjs");
        // Prepared runtime entries keep source transformation outside the measured disposal budget.
        fs.writeFileSync(
          harness,
          `
import { runUpdateDoctorLintProcess } from ${JSON.stringify(supervisor.href)};
import { installCliSignalExitHandlers } from ${JSON.stringify(signals.href)};
import { drainProcessOutput } from ${JSON.stringify(output.href)};
const releaseSignals = installCliSignalExitHandlers();
try {
  const code = await runUpdateDoctorLintProcess({
    json: true, severityMin: "error", onlyIds: ["core/doctor/runtime-tool-schemas"]
  });
  drainProcessOutput(() => process.exit(code));
} finally {
  releaseSignals();
}
`,
        );
        nodeArgs = [...resolveRuntimeWorkerArgv(supervisor).slice(0, -1), harness];
      }
      let workerPid: number | undefined;
      const result = await fixtures.track(
        runCliProcessChild({
          nodeArgs,
          env,
          timeoutMs: 60_000,
          onStdout(stdout) {
            try {
              report.resolve(JSON.parse(stdout));
            } catch {
              /* Wait for the complete JSON envelope. */
            }
          },
          async interact(child) {
            child.stdin.end();
            await waitForCliProcessStderrMarker(child, "fixture disposal entered");
            let timer: NodeJS.Timeout | undefined;
            try {
              const output = await Promise.race([
                report.promise,
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("Checks were held behind plugin disposal")),
                    5_000,
                  );
                }),
              ]);
              expect(output).toMatchObject({ ok: true, checksRun: 1, findings: [] });
              const observed: { pid: number; stateDir: string } = JSON.parse(
                fs.readFileSync(observation, "utf8"),
              );
              workerPid = observed.pid;
              expect(observed.stateDir).not.toBe(root);
              expect(fs.existsSync(observed.stateDir)).toBe(true);
            } finally {
              clearTimeout(timer);
              if (mode === "release") {
                fs.writeFileSync(release, "release");
              }
            }
          },
        }),
      );
      const diagnostics = formatCliProcessFailure({ reason: "Doctor disposal", ...result });
      expect(result.code, diagnostics).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, checksRun: 1, findings: [] });
      expect(workerPid).toBeTypeOf("number");
      expect(() => process.kill(workerPid!, 0)).toThrow();
      expect(fs.readFileSync(configPath, "utf8")).toBe(config);
      if (mode === "timeout") {
        expect(result.stderr).toMatch(/Doctor disposal timed out after \d+ms; checks completed/u);
      }
    });
  },
  90_000,
);
