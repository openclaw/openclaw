import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { cliOutputScript } from "./cli-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const childTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-cron-child-tmp-");
const sentinel = "\nEND-CRON-SUMMARY\n";
const summary = "x".repeat(128 * 1024 - sentinel.length) + sentinel;

it.each([
  ["wait success", ["run", "job-1", "--wait"], 0, "wait"],
  ["wait failure", ["run", "job-1", "--wait", "--json"], 1, "wait"],
  ["queued run", ["run", "job-1"], 0, "admission"],
  ["not-due run", ["run", "job-1", "--due"], 1, "admission"],
  ["run history", ["runs", "--id", "job-1"], 0, "history"],
  ["human error", ["show", "missing-job"], 1, "error"],
] as const)(
  "flushes cron %s output before exit",
  (_name, args, exitCode, kind) => {
    const root = tempDirs.make("openclaw-cron-output-");
    const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
    const status = exitCode === 0 ? "ok" : "error";
    const completionStatus = exitCode === 0 ? "succeeded" : "failed";
    const run = { jobId: "job-1", runId: "run-1", status, completionStatus };
    const admission =
      exitCode === 0 ? { ok: true, enqueued: true, runId: "run-1" } : { ok: true, ran: false };
    const rpcSource = `
      const summary = "x".repeat(${summary.length} - ${sentinel.length}) + ${JSON.stringify(sentinel)};
      const row = { ts: 1700000001000, ...${JSON.stringify(run)}, action: "finished",
        summary, runAtMs: 1700000000000, durationMs: 1000 };
      export async function callGatewayFromCliRuntime(method) {
        if (method === "cron.run") return ${JSON.stringify(kind === "wait" ? { ok: true, enqueued: true, runId: "run-1" } : admission)};
        if (method === "cron.runs") return { entries: [row], total: 1, offset: 0, limit: ${kind === "wait" ? 1 : 50}, hasMore: false, nextOffset: null };
        if (method === "cron.get" && ${kind === "error"}) {
          throw Object.assign(new Error("cron job not found: missing-job"), {
            name: "GatewayClientRequestError", gatewayCode: "INVALID_REQUEST",
          });
        }
        if (method === "cron.list" && ${kind === "error"}) return {
          jobs: [], snapshotRevision: "empty-1", total: 0, offset: 0, limit: 200,
          hasMore: false, nextOffset: null,
        };
        throw new Error("unexpected Gateway RPC: " + method);
      }
    `;
    const script = cliOutputScript({
      registration: [sourceUrl("./cron-cli.ts"), "registerCronCli"],
      exitUrl: sourceUrl("./one-shot-exit.ts"),
      argv: ["cron", ...args],
      modules: { "/gateway-rpc.runtime.js": rpcSource },
      setup: `
      const { applyResolvedCommandOutputMode } = await import(${JSON.stringify(sourceUrl("./json-output-mode.ts"))});
      const { isCommandJsonOutputMode } = await import(${JSON.stringify(sourceUrl("./program/json-mode.ts"))});
          program.hook("preAction", (_parent, command) => {
            const jsonMode = isCommandJsonOutputMode(command, process.argv);
            if (jsonMode !== ${kind !== "error"}) throw new Error("incorrect command output mode");
            applyResolvedCommandOutputMode(jsonMode);
          });
    `,
    });
    const result = spawnNodeEvalSync(script, {
      imports: ["tsx"],
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        TMPDIR: childTempDir,
        TEMP: childTempDir,
        TMP: childTempDir,
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
    if (kind === "error") {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
      );
      return;
    }
    expect(result.stderr).toBe("");
    const value = JSON.parse(result.stdout);
    if (kind === "admission") {
      expect(value).toEqual(admission);
      return;
    }
    expect(kind === "wait" ? value.run : value.entries[0]).toMatchObject({ ...run, summary });
    if (kind === "wait") {
      expect(value).toMatchObject({ completed: true, status, completionStatus });
    }
  },
  30_000,
);
