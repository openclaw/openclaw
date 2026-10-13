import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import * as diagnostics from "./diagnostic-events.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), isEnabled: () => true }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...(subsystem === "git/worker" ? logs : {}),
    }),
  };
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
  logs.info.mockClear();
});

it.each([
  {
    args: ["--no-lazy-fetch", "-c", "diff.private=secret", "diff", "--shortstat"],
    command: "diff",
    diffMode: "--shortstat",
  },
  { args: ["diff", "--patch", "--no-index"], command: "diff", diffMode: "--no-index" },
  { args: ["private-command"], command: "other" },
])(
  "prints attribution and a swallowed $command $diffMode timeout in the journal message",
  async ({ args: slowArgs, command, diffMode }) => {
    let clock = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    const cwd = "/private/checkouts/diagnostic-fixture";
    const privateRef = "refs/heads/private-branch";
    const run = vi.fn(async (_cwd: string, args: string[]) => {
      const timeout = args[0] !== "merge-base";
      clock += timeout ? 120_000 : 50;
      return {
        stdout: Buffer.from(timeout ? "" : "fixture output"),
        stderr: Buffer.from(timeout ? "private failure" : ""),
        code: timeout ? null : 0,
        signal: null,
        killed: timeout,
        termination: timeout ? ("timeout" as const) : ("exit" as const),
        timeoutMs: 120_000,
        windowsEncoding: null,
      };
    });
    // Exercise the real broker and logger without a worker boot or wall-clock timeout.
    vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async (input, options) => {
      clock += 400;
      if (typeof input === "function") {
        await input();
      }
      clock += 100;
      const signal = new AbortController().signal;
      for (const args of [
        ["merge-base", privateRef, "HEAD"],
        [...slowArgs, privateRef],
      ]) {
        await options.onRequest!(
          {
            type: "git.batch",
            input: { requests: [{ type: "git.text", input: { cwd, args, options: {} } }] },
          },
          { signal, yieldSignal: signal },
        );
      }
      // Optional PR statistics intentionally retain an unknown result after a timeout.
      return { ok: true, value: { creatable: true, stats: null } };
    });
    await expect(
      runGitWorkerOperation(
        {
          type: "pull-request.branch-facts",
          input: { root: cwd, branch: "fixture", mergedHeads: [], refreshIndex: true },
        },
        { git: { text: run, buffered: run } },
      ),
    ).resolves.toEqual({ creatable: true, stats: null });

    expect(logs.info).toHaveBeenCalledOnce();
    const [message, fields] = logs.info.mock.calls[0]!;
    expect(message).toMatch(/^slow Git content read \{/);
    expect(JSON.parse(message.slice("slow Git content read ".length))).toEqual(fields);
    expect(fields).toMatchObject({
      operation: "pull-request.branch-facts",
      checkoutId: expect.stringMatching(/^[a-f0-9]{16}$/),
      checkoutClass: "managed",
      workerQueueWaitMs: 400,
      firstHostRequestMs: 500,
      workerMs: 120_050,
      durationMs: 120_550,
      gitCommandCount: 2,
      summedGitWallMs: 120_050,
      summedGitQueueWaitMs: 0,
      gitStdoutBytes: 14,
      gitStderrBytes: 15,
      gitTimeoutCount: 1,
      slowestGitCommand: {
        command,
        ...(diffMode ? { diffMode } : {}),
        durationMs: 120_000,
        termination: "timeout",
      },
      outcome: "returned",
    });
    for (const privateValue of [
      cwd,
      privateRef,
      "secret",
      "private failure",
      "fixture output",
      "private-command",
    ]) {
      expect(message).not.toContain(privateValue);
      expect(JSON.stringify(fields)).not.toContain(privateValue);
    }
  },
);
