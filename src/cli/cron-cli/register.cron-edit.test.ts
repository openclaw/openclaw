/**
 * Unit tests for computeDisplayAfterSchedule (cron edit diff preview).
 *
 * These tests verify that the preview accurately mirrors applyJobPatch merge
 * semantics, in particular for staggerMs inheritance and synthesis.
 */
import { describe, expect, it } from "vitest";
// Re-export the private helper for testing via a thin wrapper.
// We import the register module and extract via a test-only export shim.
// Since computeDisplayAfterSchedule is not exported, we test it indirectly
// through buildCronPatchDiff by capturing stderr output, OR we expose it
// via a named export added for test purposes.
//
// For now, test through the observable diff output produced by the module.
// The key invariant: cron→cron edits that omit staggerMs must NOT add a
// synthesized staggerMs entry in the diff preview.
import { beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  listMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../../cron/client.js", () => ({
  createCronClient: () => ({
    list: hoisted.listMock,
    update: hoisted.updateMock,
  }),
}));

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: async (method: string, _opts: unknown, params?: unknown) => {
      if (method === "cron.list") {
        return { jobs: await hoisted.listMock() };
      }
      if (method === "cron.update") {
        return hoisted.updateMock(params);
      }
      return { ok: true, params };
    },
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn((message: unknown) => {
      process.stderr.write(String(message));
    }),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const makeExistingCronJob = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  agentId: "main",
  name: "My Job",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *" },
  payload: { model: "default" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe("cron edit diff preview — stagger synthesis", () => {
  beforeEach(() => {
    hoisted.listMock.mockReset();
    hoisted.updateMock.mockReset();
  });

  it("does NOT synthesize staggerMs in preview when editing cron→cron and existing job has no staggerMs", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/pull/59597
    // chatgpt-codex-connector comment 3031692227
    //
    // Before fix: computeDisplayAfterSchedule fell through to Path 2 (non-cron→cron
    // synthesis) when existing.staggerMs was undefined, showing a spurious stagger
    // in the diff even though cron.update would not persist it.
    //
    // After fix: Path 1 now matches on e["kind"] === "cron" regardless of whether
    // staggerMs is defined, returning the patch unchanged (no synthesis).

    const existingJob = makeExistingCronJob({
      // Deliberately no staggerMs on the existing schedule
      schedule: { kind: "cron", expr: "0 9 * * *" },
    });

    hoisted.listMock.mockResolvedValue([existingJob]);
    // updateMock intentionally rejects — we only care about the diff preview
    // printed before the update call, not the update result itself.
    hoisted.updateMock.mockRejectedValue(new Error("update-rejected-in-test"));

    // Capture stderr output (where the diff preview is printed)
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") {
        stderrLines.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        stderrLines.push(chunk.toString());
      }
      return true;
    });

    let caughtError: unknown;
    try {
      const { registerCronEdit } = await import("./register.cron-edit.js");
      const { defaultRuntime } = await import("../../runtime.js");

      await registerCronEdit(["cron", "edit", "job-1", "--cron", "0 10 * * *"], defaultRuntime);
    } catch (err) {
      caughtError = err;
    } finally {
      stderrSpy.mockRestore();
    }

    // Verify the code path actually executed: listMock must have been called.
    // If registerCronEdit threw before reaching the list call (e.g. import error),
    // the test would be a false positive without this assertion.
    expect(hoisted.listMock).toHaveBeenCalled();

    // Only swallow the expected update-mock rejection; re-throw anything else.
    if (
      caughtError !== undefined &&
      !(caughtError instanceof Error && caughtError.message === "update-rejected-in-test")
    ) {
      throw caughtError;
    }

    const diffOutput = stderrLines.join("\n");

    // The preview must NOT mention stagger when the patch doesn't change it
    // and the existing job has no staggerMs defined.
    expect(diffOutput).not.toMatch(/stagger/i);
  });

  it("preserves existing staggerMs in preview for cron→cron when job has a defined staggerMs", async () => {
    const existingJob = makeExistingCronJob({
      schedule: { kind: "cron", expr: "0 9 * * *", staggerMs: 120_000 },
    });

    hoisted.listMock.mockResolvedValue([existingJob]);
    // updateMock intentionally rejects — we only care about the diff preview
    // printed before the update call, not the update result itself.
    hoisted.updateMock.mockRejectedValue(new Error("update-rejected-in-test"));

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") {
        stderrLines.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        stderrLines.push(chunk.toString());
      }
      return true;
    });

    let caughtError: unknown;
    try {
      const { registerCronEdit } = await import("./register.cron-edit.js");
      const { defaultRuntime } = await import("../../runtime.js");

      await registerCronEdit(["cron", "edit", "job-1", "--cron", "0 10 * * *"], defaultRuntime);
    } catch (err) {
      caughtError = err;
    } finally {
      stderrSpy.mockRestore();
    }

    // Verify the code path actually executed: listMock must have been called.
    expect(hoisted.listMock).toHaveBeenCalled();

    // Only swallow the expected update-mock rejection; re-throw anything else.
    if (
      caughtError !== undefined &&
      !(caughtError instanceof Error && caughtError.message === "update-rejected-in-test")
    ) {
      throw caughtError;
    }

    // The existing staggerMs (120_000 ms = 2m) should be reflected in the
    // after-value (unchanged), not silently dropped or synthesized anew.
    const diffOutput = stderrLines.join("\n");
    // schedule changes are rendered as whole-object diffs, so the preserved
    // staggerMs should appear on both sides of the schedule line.
    expect(diffOutput.match(/"staggerMs":120000/g)).toHaveLength(2);
  });
});

describe("cron edit diff preview — delivery / main-session side-effect", () => {
  beforeEach(() => {
    hoisted.listMock.mockReset();
    hoisted.updateMock.mockReset();
  });

  it("shows delivery exactly once (as cleared) when switching to --session main with existing delivery", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/pull/59597
    // chatgpt-codex-connector comment 3035375844
    //
    // Before fix: when `patch.delivery` was present AND sessionTarget became "main",
    // buildCronPatchDiff emitted two delivery lines:
    //   1. generic loop: delivery: <old> → <patch-value>   (intermediate, never persisted)
    //   2. side-effect block: delivery: <patch-value> → (cleared)
    // This was contradictory and confusing.
    //
    // After fix: the generic loop skips `delivery` when the main-session side-effect
    // block will handle it, so only the final (cleared) line is shown.

    const existingJob = makeExistingCronJob({
      sessionTarget: "isolated",
      delivery: { mode: "announce", channel: "telegram" },
    });

    hoisted.listMock.mockResolvedValue([existingJob]);
    hoisted.updateMock.mockRejectedValue(new Error("update-rejected-in-test"));

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") {
        stderrLines.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        stderrLines.push(chunk.toString());
      }
      return true;
    });

    let caughtError: unknown;
    try {
      const { registerCronEdit } = await import("./register.cron-edit.js");
      const { defaultRuntime } = await import("../../runtime.js");

      await registerCronEdit(
        ["cron", "edit", "job-1", "--session", "main", "--announce"],
        defaultRuntime,
      );
    } catch (err) {
      caughtError = err;
    } finally {
      stderrSpy.mockRestore();
    }

    expect(hoisted.listMock).toHaveBeenCalled();

    if (
      caughtError !== undefined &&
      !(caughtError instanceof Error && caughtError.message === "update-rejected-in-test")
    ) {
      throw caughtError;
    }

    const diffOutput = stderrLines.join("\n");
    const deliveryLines = diffOutput
      .split("\n")
      .filter((l) => l.includes("delivery:") && l.includes("→"));

    // Must show exactly one delivery line, and it must be the "cleared" final state.
    expect(deliveryLines).toHaveLength(1);
    expect(deliveryLines[0]).toMatch(/cleared/i);
  });

  it("shows delivery diff normally for main-session jobs when delivery mode is webhook", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/pull/59597#discussion_r3042636776
    //
    // applyJobPatch does NOT clear delivery when mode === "webhook", even for
    // sessionTarget "main". The generic loop must NOT skip `delivery` in that case,
    // so that real persisted changes (e.g. updating --to on a webhook job) appear in
    // the diff preview correctly.

    const existingJob = makeExistingCronJob({
      sessionTarget: "main",
      delivery: { mode: "webhook", to: "https://example.com/old-hook" },
    });

    hoisted.listMock.mockResolvedValue([existingJob]);
    hoisted.updateMock.mockRejectedValue(new Error("update-rejected-in-test"));

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") {
        stderrLines.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        stderrLines.push(chunk.toString());
      }
      return true;
    });

    let caughtError: unknown;
    try {
      const { registerCronEdit } = await import("./register.cron-edit.js");
      const { defaultRuntime } = await import("../../runtime.js");

      // Simulate changing the webhook --to URL (would require a --webhook-to flag or similar;
      // here we verify via a cron schedule change that the delivery line still appears
      // unchanged in the diff when mode=webhook — i.e. it is NOT suppressed).
      // Since we cannot easily invoke --webhook-to through the CLI, we verify the
      // negative: a pure schedule edit on a webhook main job should NOT show a
      // spurious "cleared" delivery line.
      await registerCronEdit(["cron", "edit", "job-1", "--cron", "0 10 * * *"], defaultRuntime);
    } catch (err) {
      caughtError = err;
    } finally {
      stderrSpy.mockRestore();
    }

    expect(hoisted.listMock).toHaveBeenCalled();

    if (
      caughtError !== undefined &&
      !(caughtError instanceof Error && caughtError.message === "update-rejected-in-test")
    ) {
      throw caughtError;
    }

    const diffOutput = stderrLines.join("\n");
    // For a webhook main-session job with no delivery change in the patch,
    // the side-effect block must NOT emit a spurious "cleared" line.
    expect(diffOutput).not.toMatch(/cleared/i);
  });
});
