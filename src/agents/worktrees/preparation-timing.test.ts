import { serialize } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
import { GitCommandTimeoutError } from "../../infra/git-exec.js";
import * as runner from "../../process/exec-runner.js";
import { createOpenClawStateLeaseAbortError } from "../../state/openclaw-state-lease-error.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
import {
  markManagedWorktreePreparation,
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
  withWorktreePreparationTiming as withTiming,
} from "./preparation-timing.js";

const { log, event } = vi.hoisted(() => ({ log: vi.fn(), event: vi.fn() }));
// mock-isolation: Observe the preparation receipt without a process-wide diagnostic queue.
vi.mock("../../infra/diagnostic-events.js", () => ({
  createQueuedDiagnosticPhaseEmitter: () => event,
}));
// mock-isolation: Keep the logging sink outside this timing-contract fixture.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ info: log }) }));

afterEach(vi.restoreAllMocks);
afterEach(vi.resetAllMocks);

it("reports completed native clone writes separately from unmeasured copies and failures", async () => {
  vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue("btrfs");
  const run = vi.spyOn(runner, "runCommandBuffersWithTimeout");
  const options = { commitGuard: () => {} };
  const backend = await detectWorktreeFilesystemBackend("/synthetic", options);
  expect(backend?.id).toBe("btrfs");
  await withTiming("managed", async () => {
    for (const reply of [
      { type: "written", cloneWriteBytes: 4096 },
      { type: "written", cloneWriteBytes: 8192 },
      { type: "written" },
      { type: "failed", message: "clone unavailable" },
    ]) {
      run.mockResolvedValueOnce({
        stdout: serialize(reply),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        windowsEncoding: null,
      });
      const copy = backend!.cloneTemplate("/synthetic/source", "/synthetic/clone", options);
      if (reply.type === "failed") {
        await expect(copy).rejects.toThrow("clone unavailable");
      } else {
        await copy;
      }
    }
  });
  expect(log.mock.calls.at(-1)?.[1].templateDetails).toMatchObject({
    nativeCloneCount: 3,
    nativeCloneWriteBytes: 12288,
    nativeCloneUnmeasuredCount: 1,
  });
});

it.each(["original", "lease", "unrelated"] as const)(
  "attributes nested preparation through lease wrapping (%s)",
  async (wrapped) => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new GitCommandTimeoutError("synthetic private setup output");
    const reported =
      wrapped === "original"
        ? failure
        : createOpenClawStateLeaseAbortError(
            AbortSignal.abort(wrapped === "lease" ? failure : new Error("separate cancellation")),
            "operation",
            "workspace",
          );
    const errorPhase = wrapped === "unrelated" ? "unattributed" : "containerStart";
    const warm = Object.freeze({ reason: "ready", backend: "btrfs", cloneBytes: 42 });
    const phases = { templateApply: 52, containerStart: 8 };
    await expect(
      withTiming("sandbox", async () => {
        markManagedWorktreePreparation();
        setWorktreePreparationTemplate("warm", warm);
        await timeWorktreePreparationPhase("templateApply", async () => {
          clock += 12;
          await withTiming("managed", () =>
            timeWorktreePreparationPhase("checkout", async () => (clock += 40)),
          );
        });
        try {
          await timeWorktreePreparationPhase("baseWait", () =>
            timeWorktreePreparationPhase("containerStart", async () => {
              clock += 8;
              throw failure;
            }),
          );
        } catch {
          throw reported;
        }
      }),
    ).rejects.toBe(reported);
    expect(event.mock.calls[0]?.[0]).toMatchObject({
      durationMs: 40,
      details: { kind: "managed", template: "unavailable", outcome: "returned", checkout: 40 },
    });
    expect(event).toHaveBeenCalledTimes(2);
    expect(event.mock.calls[1]?.[0]).toMatchObject({
      name: "worktree.preparation",
      durationMs: 60,
      details: {
        kind: "sandbox",
        template: "warm",
        outcome: "threw",
        errorClass: reported.name,
        errorPhase,
        unattributedMs: 0,
        ...phases,
        ...Object.fromEntries(
          Object.entries(warm).map(([key, value]) => [`template.${key}`, value]),
        ),
      },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
    expect(log.mock.calls[1]?.[1]).toMatchObject({
      errorClass: reported.name,
      errorPhase,
    });
    expect(log.mock.calls[1]?.[1].consoleMessage).toContain(`"errorPhase":"${errorPhase}"`);
  },
);

it("omits unmanaged sandboxes and preserves results if a diagnostics sink fails", async () => {
  await withTiming("sandbox", async () => "unmanaged");
  expect([log.mock.calls, event.mock.calls]).toEqual([[], []]);
  log.mockImplementation(() => {
    throw new Error("log sink unavailable");
  });
  await expect(withTiming("managed", async () => "ready")).resolves.toBe("ready");
});

it("reports uncovered time without double-counting overlapping phases", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  await withTiming("managed", async () => {
    clock = 10;
    const finishBase = startWorktreePreparationPhase("base");
    clock = 20;
    const finishWait = startWorktreePreparationPhase("baseWait");
    clock = 40;
    finishBase();
    finishBase();
    clock = 50;
    finishWait();
    const finishPatch = startWorktreePreparationPhase("reuse.patch");
    clock = 60;
    finishPatch();
  });
  expect(log.mock.calls[0]?.[1]).toMatchObject({
    durationMs: 60,
    unattributedMs: 10,
    reuseDominantPhase: "reuse.patch",
    phaseDurationsMs: { base: 30, baseWait: 30, "reuse.patch": 10 },
  });
  expect(log.mock.calls[0]?.[1].consoleMessage).toContain("reuseDominantPhase=reuse.patch");
});
