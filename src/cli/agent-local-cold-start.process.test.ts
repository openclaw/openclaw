import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Work a one-shot `agent --local` turn starts before its first model request. Every
// Node process and worker thread boots its own module graph on the critical path, so
// counts catch cold-start regressions that wall time on a shared CI host cannot.
// The budget is a ceiling set from Linux CI (macOS starts one worker fewer); lower it in
// the PR that removes work. NODE_OPTIONS carries the ledger into descendant processes
// that inherit the environment and into every worker; spawn calls are counted
// separately for descendants that start with a clean environment.
const COLD_START_BUDGET = { nodeProcesses: 4, nodeSpawns: 5, workerThreads: 19 };

const LEDGER_PRELOAD = `
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
const ledger = process.env.OPENCLAW_TEST_COLD_START_LEDGER;
const marker = Symbol.for("openclaw.test.coldStartLedger");
if (ledger && !globalThis[marker]) {
  globalThis[marker] = true;
  const record = (kind) => fs.appendFileSync(ledger, Date.now() + " " + kind + "\\n");
  if (workerThreads.isMainThread) {
    record("node-process");
  }
  for (const name of ["spawn", "fork", "execFile", "spawnSync", "execFileSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (command, ...rest) {
      const executable = name === "fork" ? process.execPath : String(command);
      if (executable === process.execPath || /^node(\\.exe)?$/u.test(path.basename(executable))) {
        record("node-spawn");
      }
      return original.call(this, command, ...rest);
    };
  }
  const Worker = workerThreads.Worker;
  workerThreads.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      record("worker-thread");
    }
  };
  syncBuiltinESMExports();
}
`;

// Windows always respawns for its stack size, so its launch topology differs by design.
it.skipIf(process.platform === "win32")(
  "agent --local stays within its process and worker budget before the first request",
  { timeout: 120_000 },
  async () => {
    const root = tempDirs.make("openclaw-local-cold-start-");
    const ledger = path.join(root, "ledger.txt");
    const preload = path.join(root, "ledger-preload.mjs");
    await fs.writeFile(preload, LEDGER_PRELOAD);
    const fixture = createCliProcessFixture(root, {
      TMPDIR: root,
      NO_COLOR: "1",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      // Count the default startup; only host CA discovery stays environment-dependent.
      OPENCLAW_NO_RESPAWN: undefined,
      OPENCLAW_NODE_EXTRA_CA_CERTS_READY: "1",
      OPENCLAW_TEST_COLD_START_LEDGER: ledger,
    });
    let firstRequestAt: number | undefined;
    const server = await startOpenAiResponsesModelServer({
      modelId: "gpt-5.2",
      bindError: "cold-start provider did not bind",
      onRequest: async (request, response) => {
        firstRequestAt ??= Date.now();
        request.resume();
        await once(request, "end");
        writeOpenAiResponsesText(response, {
          text: "cold start ok",
          messageId: "msg_cold_start",
          responseId: "resp_cold_start",
        });
      },
    });
    try {
      const config = createOpenAiResponsesModelConfig({
        baseUrl: server.baseUrl,
        providerId: "openai",
        modelId: "gpt-5.2",
        reasoning: false,
        toolProfile: "full",
      });
      config.agents = {
        ...config.agents,
        defaults: { ...config.agents?.defaults, workspace: path.join(root, "workspace") },
      };
      await fixture.writeConfig(config);
      const result = await runCliProcessChild({
        env: fixture.env,
        // The default install runs the CLI on Node, also when Vitest itself runs on Bun.
        nodeExecutable: resolveTestNodeExecPath(),
        nodeArgs: [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          fileURLToPath(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "agent",
          "--local",
          "--message",
          "Reply with exactly: ok",
          "--thinking",
          "off",
          "--json",
        ],
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(result.stdout)).toMatchObject({ payloads: [{ text: "cold start ok" }] });
      const counts = { nodeProcesses: 0, nodeSpawns: 0, workerThreads: 0 };
      for (const line of (await fs.readFile(ledger, "utf8")).trim().split("\n")) {
        const [at, kind] = line.split(" ");
        if (Number(at) > firstRequestAt!) {
          continue;
        }
        if (kind === "node-process") {
          counts.nodeProcesses++;
        } else if (kind === "node-spawn") {
          counts.nodeSpawns++;
        } else if (kind === "worker-thread") {
          counts.workerThreads++;
        }
      }
      const report = JSON.stringify(counts);
      expect(counts.nodeProcesses, report).toBeLessThanOrEqual(COLD_START_BUDGET.nodeProcesses);
      expect(counts.nodeSpawns, report).toBeLessThanOrEqual(COLD_START_BUDGET.nodeSpawns);
      expect(counts.workerThreads, report).toBeLessThanOrEqual(COLD_START_BUDGET.workerThreads);
    } finally {
      await server.close();
    }
  },
);
