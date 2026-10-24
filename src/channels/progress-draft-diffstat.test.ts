import { expect, it } from "vitest";
import { createProgressDraftDiffStatTracker } from "./progress-draft-diffstat.js";

function createTracker() {
  const tracker = createProgressDraftDiffStatTracker({ canStage: () => true });
  return {
    ...tracker,
    stage: (toolCallId: string, name: string, args: Record<string, unknown>, phase = "start") =>
      tracker.stageToolEvent({ toolCallId, name, phase, args }),
    write: (toolCallId: string, content = "line", path = "src/example.ts", phase = "start") =>
      tracker.stageToolEvent({ toolCallId, name: "write", phase, args: { path, content } }),
    complete: (toolCallId: string, status = "completed") =>
      tracker.commitItemEvent({ toolCallId, phase: "end", status }),
    expectStat: (files: number, added: number, removed: number) =>
      expect(tracker.resolve()).toEqual({ files, added, removed }),
  };
}

it.each([
  ["", 0],
  ["one", 1],
  ["one\n", 2],
  ["one\r", 2],
  ["one\r\n", 2],
  ["\r\n", 2],
  ["one\rtwo\nthree\r\nfour", 4],
  ["\r\r\n\n", 4],
])("preserves completed write and edit line counts for %j", (content, lineCount) => {
  const tracker = createTracker();
  tracker.write("write", content, "example.txt");
  tracker.complete("write");
  tracker.expectStat(1, lineCount, 0);

  tracker.stage("edit", "edit", { path: "example.txt", oldText: content, newText: content });
  tracker.complete("edit");
  tracker.expectStat(1, lineCount * 2, lineCount);
});

it("stages starts and commits successful terminal items additively", () => {
  const tracker = createTracker();

  tracker.write("write-1", "one\ntwo");
  expect(tracker.resolve()).toBeUndefined();
  tracker.write("write-1", "ignored\npartial\nargs", "src/example.ts", "update");
  expect(tracker.resolve()).toBeUndefined();

  tracker.complete("write-1");
  tracker.expectStat(1, 2, 0);

  tracker.stage("edit-1", "edit", {
    path: "src/example.ts",
    edits: [{ oldText: "one\ntwo", newText: "three" }],
  });
  tracker.complete("edit-1");
  tracker.expectStat(1, 3, 2);

  for (const status of ["failed", "error", "blocked", "unknown", ""]) {
    const toolCallId = `failed-${status}`;
    tracker.write(toolCallId, "ignored", `src/${toolCallId}.ts`);
    tracker.complete(toolCallId, status);
  }
  tracker.expectStat(1, 3, 2);

  tracker.stage("patch-1", "apply_patch", {
    input:
      "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-three\n+four\n+five\n*** Add File: src/new.ts\n+new\n+line\n*** End Patch",
  });
  tracker.complete("patch-1");
  tracker.expectStat(2, 7, 3);

  tracker.stage("codex-patch-1", "apply_patch", {
    changes: [
      { path: "src/example.ts", stat: { added: 7, removed: 3 } },
      { path: "src/third.ts", stat: { added: 5, removed: 2 } },
    ],
  });
  tracker.complete("codex-patch-1");
  tracker.expectStat(3, 19, 8);

  tracker.write("pending-reset", "pending", "src/pending-reset.ts");
  tracker.reset();
  expect(tracker.resolve()).toBeUndefined();
  tracker.complete("pending-reset");
  expect(tracker.resolve()).toBeUndefined();
});

it("bounds pending staging and distinct committed file tracking", () => {
  const tracker = createTracker();

  for (let index = 0; index < 65; index += 1) {
    tracker.write(`write-${index}`, "line", `src/file-${index}.ts`);
  }
  expect(tracker.resolve()).toBeUndefined();
  for (let index = 0; index < 65; index += 1) {
    tracker.complete(`write-${index}`);
  }
  tracker.expectStat(64, 64, 0);

  for (let index = 64; index < 257; index += 1) {
    const toolCallId = `restaged-write-${index}`;
    tracker.write(toolCallId, "line", `src/file-${index}.ts`);
    tracker.complete(toolCallId);
  }
  tracker.expectStat(257, 257, 0);

  tracker.stage("edit-known", "edit", {
    path: "src/file-0.ts",
    oldText: "one\ntwo",
    newText: "one\ntwo\nthree",
  });
  tracker.complete("edit-known");
  tracker.expectStat(257, 260, 2);
});
