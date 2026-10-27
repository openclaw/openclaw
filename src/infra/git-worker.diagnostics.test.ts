import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import * as diagnostics from "./diagnostic-events.js";
import type { GitWorkerCommand } from "./git-worker-contract.js";
import { repository } from "./git-worker-lifecycle.test-support.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { getTrackedWorkerLifecycleSnapshot } from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 3,
}));

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  logs.info.mockClear();
  tempDirs.cleanup();
});

const tempDirs = createTempDirTracker();
it.each([
  ["reads", false],
  ["summary", false],
  ["content", true],
  ["workspace", true],
  ["worktrees", false],
  ["worktreeMaintenance", false],
] as const)("preserves the %s idle policy (floor=%s)", async (owner, floor) => {
  const root = tempDirs.make("openclaw-git-idle-policy-");
  const cwd = owner === "summary" || owner === "content" ? await repository(root) : root;
  const diff = expect.objectContaining({ files: [], additions: 0, deletions: 0 });
  const cases: Record<typeof owner, [GitWorkerCommand, unknown]> = {
    reads: [{ type: "repository.identities", input: { roots: [] } }, []],
    summary: [{ type: "checkout.diff", input: { cwd, summaryOnly: true } }, diff],
    content: [{ type: "checkout.diff", input: { cwd } }, diff],
    workspace: [
      {
        type: "workspace.manifest.nodes",
        input: { payload: new TextEncoder().encode(JSON.stringify({ root, paths: [] })) },
      },
      { value: [], hashes: [], metrics: { contentHashCount: 0, memoHitCount: 0 } },
    ],
    worktrees: [{ type: "worktree.directory-size", input: { root } }, 0],
    worktreeMaintenance: [{ type: "worktree.eviction-repositories", input: { repoRoots: [] } }, []],
  };
  const [command, expected] = cases[owner];
  const lifecycle = () =>
    getTrackedWorkerLifecycleSnapshot().workerLifecycle.find(
      (worker) => worker.script === "git-operation.worker.js",
    );
  const starts = () => lifecycle()?.started ?? 0;
  const exits = (reason: string) =>
    lifecycle()?.retired.find((retirement) => retirement.reason === reason)?.count ?? 0;
  const live = () => {
    const { started = 0, retired = [] } = lifecycle() ?? {};
    return started - retired.reduce((sum, { count }) => sum + count, 0);
  };
  const before = starts();
  const run = () => expect(runGitWorkerOperation(command)).resolves.toEqual(expected);
  // Existing mock availableParallelism=3 makes reads a two-worker pool.
  const initialWorkers = owner === "reads" ? 2 : 1;
  // Real Git process cleanup may poll timers while the task is awaited.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
    shouldAdvanceTime: true,
  });
  for (const pollMs of owner === "reads" ? [0, 45_000, 60_001, 90_000] : [0]) {
    await vi.advanceTimersByTimeAsync(pollMs);
    await Promise.all(Array.from({ length: initialWorkers }, run));
    expect(starts() - before).toBe(initialWorkers);
  }
  const idleMs = owner === "reads" ? 120_001 : 60_001;
  for (const [reason, retained, retire] of [
    ["idle_timeout", Number(floor), () => vi.advanceTimersByTimeAsync(idleMs)],
    ["memory_pressure", 0, () => channel("openclaw.memory.critical").publish({})],
  ] as const) {
    const started = starts(),
      retired = exits(reason),
      active = live();
    await retire();
    await vi.waitFor(() => expect(exits(reason) - retired).toBe(active - retained));
    if (reason === "idle_timeout") {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    }
    expect([live(), starts()]).toEqual([retained, started]); // No eager replacements.
    await run();
    expect(starts()).toBe(started + Number(!retained));
  }
  await drainGlobalSingletonLifecycleState();
  expect(live()).toBe(0);
});

const cwd = "/private/checkouts/diagnostic-fixture";
const branchFacts = {
  type: "pull-request.branch-facts",
  input: {
    root: cwd,
    branch: "fixture",
    mergedHeads: [],
    refreshIndex: true,
    comparison: { statsBase: null, creatable: true, equalPushedTips: false, complete: true },
  },
} as const;
const checkoutDiff = { type: "checkout.diff", input: { cwd, summaryOnly: true } } as const;

it.each([
  [
    branchFacts,
    ["--no-lazy-fetch", "-c", "diff.private=secret", "diff", "--shortstat"],
    "diff",
    "--shortstat",
  ],
  [branchFacts, ["diff", "--patch", "--no-index"], "diff", "--no-index"],
  [branchFacts, ["private-command"], "other", undefined],
  [checkoutDiff, ["diff", "--raw"], "diff", "--raw"],
] as const)(
  "prints %j attribution and a %j %s %s timeout in the journal message",
  async (request, slowArgs, command, diffMode) => {
    const operation = request.type;
    let clock = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    const privateRef = "refs/heads/private-branch";
    const value =
      operation === "checkout.diff"
        ? { files: [], additions: 0, deletions: 0 }
        : { creatable: true, stats: null };
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
    vi.spyOn(WorkerTaskPoolCore.prototype, "run").mockImplementation(async (input, options) => {
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
      return { ok: true, value };
    });
    await expect(
      runGitWorkerOperation(request, { git: { text: run, buffered: run } }),
    ).resolves.toEqual(value);

    expect(logs.info).toHaveBeenCalledOnce();
    const [message, fields] = logs.info.mock.calls[0]!;
    expect(message).toMatch(/^slow Git content read \{/);
    expect(JSON.parse(message.slice("slow Git content read ".length))).toEqual(fields);
    expect(fields).toMatchObject({
      operation,
      ...(operation === "checkout.diff" ? { scope: "all", summaryOnly: true } : {}),
      checkoutId: expect.stringMatching(/^[a-f0-9]{16}$/),
      checkoutClass: operation === "checkout.diff" ? "unspecified" : "managed",
      workerQueueWaitMs: 400,
      durationMs: 120_550,
      gitTimeoutCount: 1,
      slowestGitCommand: {
        command,
        ...(diffMode ? { diffMode } : {}),
        durationMs: 120_000,
        termination: "timeout",
      },
      outcome: "returned",
    });
    if (operation !== "checkout.diff") {
      expect(fields).not.toHaveProperty("scope");
      expect(fields).not.toHaveProperty("summaryOnly");
    }
    const journal = `${message}\n${JSON.stringify(fields)}`;
    for (const privateValue of [
      cwd,
      privateRef,
      "secret",
      "private failure",
      "fixture output",
      "private-command",
    ]) {
      expect(journal).not.toContain(privateValue);
    }
  },
);
