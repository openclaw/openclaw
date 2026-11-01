import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { doctorOutputEntrypoints } from "./cli-entrypoint.test-support.js";
import { cliChildEnv, cliOutputScript } from "./cli-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sentinel = "\nEND-CRON-SUMMARY\n";
const summary = "x".repeat(128 * 1024 - sentinel.length) + sentinel;

it.each([
  ["wait success", ["run", "job-1", "--wait"], 0, "wait"],
  ["wait failure", ["run", "job-1", "--wait", "--json"], 1, "wait"],
  ["run history", ["runs", "--id", "job-1"], 0, "history"],
] as const)(
  "flushes cron %s output before exit",
  (_name, args, exitCode, kind) => {
    const root = tempDirs.make("openclaw-cron-output-");
    const moduleUrl = (relative: string) =>
      new URL(relative, resolveRuntimeWorkerUrl(doctorOutputEntrypoints.oneShotExit)).href;
    const status = exitCode === 0 ? "ok" : "error";
    const completionStatus = exitCode === 0 ? "succeeded" : "failed";
    const run = { jobId: "job-1", runId: "run-1", status, completionStatus };
    const rpcSource = `
      const summary = "x".repeat(${summary.length} - ${sentinel.length}) + ${JSON.stringify(sentinel)};
      const row = { ts: 1700000001000, ...${JSON.stringify(run)}, action: "finished",
        summary, runAtMs: 1700000000000, durationMs: 1000 };
      export async function callGatewayFromCliRuntime(method) {
        if (method === "cron.run") return { ok: true, enqueued: true, runId: "run-1" };
        if (method === "cron.runs") return { entries: [row], total: 1, offset: 0, limit: ${kind === "wait" ? 1 : 50}, hasMore: false, nextOffset: null };
        throw new Error("unexpected Gateway RPC: " + method);
      }
    `;
    const script = cliOutputScript({
      registration: [moduleUrl("./cron-cli.js"), "registerCronCli"],
      exitUrl: moduleUrl("./one-shot-exit.js"),
      argv: ["cron", ...args],
      modules: { "/gateway-rpc.runtime.js": rpcSource },
      setup: `
      const { applyResolvedCommandOutputMode } = await import(${JSON.stringify(moduleUrl("./json-output-mode.js"))});
      const { isCommandJsonOutputMode } = await import(${JSON.stringify(moduleUrl("./program/json-mode.js"))});
          program.hook("preAction", (_parent, command) => {
            const jsonMode = isCommandJsonOutputMode(command, process.argv);
            if (!jsonMode) throw new Error("incorrect command output mode");
            applyResolvedCommandOutputMode(jsonMode);
          });
    `,
    });
    const result = spawnNodeEvalSync(script, {
      env: {
        ...process.env,
        ...cliChildEnv(root),
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      maxBuffer: 2 * summary.length,
      timeout: 30_000,
    });

    expect([result.error, result.signal, result.status]).toEqual([undefined, null, exitCode]);
    expect(result.stderr).toBe("");
    const value = JSON.parse(result.stdout);
    expect(kind === "wait" ? value.run : value.entries[0]).toMatchObject({ ...run, summary });
    if (kind === "wait") {
      expect(value).toMatchObject({ completed: true, status, completionStatus });
    }
  },
  30_000,
);
