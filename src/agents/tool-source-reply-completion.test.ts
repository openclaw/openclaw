import { describe, expect, it } from "vitest";
import { attachEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import { copyInternalToolResultState } from "./runtime/internal-hooks.js";
import {
  createSourceReplyBatchCompletion,
  ToolSourceReplyCell,
} from "./tool-source-reply-completion.js";

function deliveredResult() {
  return attachEmbeddedMessageDeliveryFact(
    { content: [], details: {} },
    {
      status: "settled",
      sourceReplyDelivered: true,
      partialDelivery: false,
      createdThreadIds: [],
    },
  );
}

describe("private source-reply cell completion", () => {
  const inputA = {};

  it("does not accept public delivery or cell fields as completion authority", () => {
    const owner = createSourceReplyBatchCompletion();
    const cell = new ToolSourceReplyCell(inputA);
    cell.observe(structuredClone(deliveredResult()));
    expect(owner.complete([cell.attach({}, "completed", inputA)], false, inputA)).toBe(false);
    expect(
      owner.complete([{ finalDelivered: true, settled: true, terminate: true }], false, inputA),
    ).toBe(false);
  });

  it.each([
    { status: "settled" as const, partialDelivery: false, sourceReplyDelivered: undefined },
    { status: "settled" as const, partialDelivery: true, sourceReplyDelivered: true as const },
    { status: "dryRun" as const, partialDelivery: false, sourceReplyDelivered: true as const },
    { status: "failed" as const, partialDelivery: false, sourceReplyDelivered: true as const },
  ])("does not complete progress, partial, dry-run or failed delivery: %j", (fact) => {
    const owner = createSourceReplyBatchCompletion();
    const cell = new ToolSourceReplyCell(inputA);
    cell.observe(
      attachEmbeddedMessageDeliveryFact(
        { content: [], details: {} },
        { ...fact, createdThreadIds: [] },
      ),
    );
    expect(owner.complete([cell.attach({}, "completed", inputA)], false, inputA)).toBe(false);
  });

  it("preserves delivered authority through private transforms and guest failure", () => {
    const owner = createSourceReplyBatchCompletion();
    const cell = new ToolSourceReplyCell(inputA);
    cell.observe(copyInternalToolResultState(deliveredResult(), {}));
    const result = cell.attach({}, "failed", inputA);
    owner.observe(result);
    // The actual after-tool hook can fail after observing the committed control.
    expect(owner.complete([{ isError: true }], false, inputA)).toBe(true);
    expect(owner.complete([copyInternalToolResultState(result, {})], false, inputA)).toBe(false);
  });

  it("holds finality across exec/wait until every sibling cell settles", () => {
    const owner = createSourceReplyBatchCompletion();
    const reply = new ToolSourceReplyCell(inputA);
    const sibling = new ToolSourceReplyCell(inputA);
    reply.observe(deliveredResult());
    expect(
      owner.complete(
        [reply.attach({}, "completed", inputA), sibling.attach({}, "waiting", inputA)],
        false,
        inputA,
      ),
    ).toBe(false);
    expect(owner.complete([sibling.attach({}, "waiting", inputA)], false, inputA)).toBe(false);
    expect(owner.complete([sibling.attach({}, "completed", inputA)], false, inputA)).toBe(true);
    expect(owner.complete([reply.attach({}, "completed", inputA)], false, inputA)).toBe(false);
  });

  it("joins additional sibling cells without losing the original batch", () => {
    const owner = createSourceReplyBatchCompletion();
    const reply = new ToolSourceReplyCell(inputA);
    const sibling = new ToolSourceReplyCell(inputA);
    const laterSibling = new ToolSourceReplyCell(inputA);
    reply.observe(deliveredResult());
    expect(
      owner.complete(
        [reply.attach({}, "waiting", inputA), sibling.attach({}, "waiting", inputA)],
        false,
        inputA,
      ),
    ).toBe(false);
    expect(
      owner.complete(
        [reply.attach({}, "completed", inputA), laterSibling.attach({}, "waiting", inputA)],
        false,
        inputA,
      ),
    ).toBe(false);
    expect(owner.complete([sibling.attach({}, "completed", inputA)], false, inputA)).toBe(false);
    expect(owner.complete([laterSibling.attach({}, "completed", inputA)], false, inputA)).toBe(
      true,
    );
  });

  it("does not transfer finality to an unrelated batch", () => {
    const owner = createSourceReplyBatchCompletion();
    const reply = new ToolSourceReplyCell(inputA);
    reply.observe(deliveredResult());
    expect(owner.complete([reply.attach({}, "waiting", inputA)], false, inputA)).toBe(false);
    expect(
      owner.complete(
        [new ToolSourceReplyCell(inputA).attach({}, "completed", inputA)],
        false,
        inputA,
      ),
    ).toBe(false);
    expect(owner.complete([reply.attach({}, "completed", inputA)], false, inputA)).toBe(true);
  });

  it("disarms an old batch when accepted steering precedes its eventual wait", () => {
    const owner = createSourceReplyBatchCompletion();
    const reply = new ToolSourceReplyCell(inputA);
    const sibling = new ToolSourceReplyCell(inputA);
    const inputB = {};
    reply.observe(deliveredResult());
    expect(
      owner.complete(
        [reply.attach({}, "completed", inputA), sibling.attach({}, "waiting", inputA)],
        true,
        inputA,
      ),
    ).toBe(false);
    expect(owner.complete([sibling.attach({}, "completed", inputB)], false, inputB)).toBe(false);
    expect(owner.complete([reply.attach({}, "completed", inputB)], false, inputB)).toBe(false);
    expect(reply.finalDelivered).toBe(true);
  });

  it("keeps a direct final reply pending behind an unfinished cell", () => {
    const owner = createSourceReplyBatchCompletion();
    const sibling = new ToolSourceReplyCell(inputA);
    expect(owner.complete([sibling.attach({}, "waiting", inputA)], true, inputA)).toBe(false);
    expect(owner.complete([sibling.attach({}, "completed", inputA)], false, inputA)).toBe(true);
  });

  it.each([false, true])(
    "keeps failed-publication observations scoped to their input (new input=%s)",
    (newInput) => {
      const owner = createSourceReplyBatchCompletion();
      const cell = new ToolSourceReplyCell(inputA);
      cell.observe(deliveredResult());
      owner.observe(cell.attach({}, "completed", inputA));
      // Result publication failed before complete() could enroll the observation.
      expect(owner.complete([], false, newInput ? {} : inputA)).toBe(!newInput);
      expect(cell.finalDelivered).toBe(true);
    },
  );

  it("does not enroll a late old-input observation in a new input's batch", () => {
    const owner = createSourceReplyBatchCompletion();
    const inputB = {};
    const oldCell = new ToolSourceReplyCell(inputA);
    const newCell = new ToolSourceReplyCell(inputB);
    expect(owner.complete([], false, inputB)).toBe(false);
    oldCell.observe(deliveredResult());
    owner.observe(oldCell.attach({}, "waiting", inputA));
    newCell.observe(deliveredResult());
    expect(owner.complete([newCell.attach({}, "completed", inputB)], false, inputB)).toBe(true);
    expect(oldCell.finalDelivered).toBe(true);
    expect(oldCell.settled).toBe(false);
  });

  it("does not reassign an old cell's final reply when a new input waits on it", () => {
    const owner = createSourceReplyBatchCompletion();
    const inputB = {};
    const oldCell = new ToolSourceReplyCell(inputA);
    oldCell.observe(deliveredResult());
    expect(owner.complete([oldCell.attach({}, "completed", inputB)], false, inputB)).toBe(false);
    expect(oldCell.finalDelivered).toBe(true);
  });

  it("joins an old cell waited by the current batch before consuming its fresh final reply", () => {
    const owner = createSourceReplyBatchCompletion();
    const inputB = {};
    const oldCell = new ToolSourceReplyCell(inputA);
    const newCell = new ToolSourceReplyCell(inputB);
    oldCell.observe(deliveredResult());
    newCell.observe(deliveredResult());
    expect(
      owner.complete(
        [oldCell.attach({}, "waiting", inputB), newCell.attach({}, "completed", inputB)],
        false,
        inputB,
      ),
    ).toBe(false);
    expect(owner.complete([oldCell.attach({}, "waiting", inputB)], false, inputB)).toBe(false);
    expect(owner.complete([oldCell.attach({}, "completed", inputB)], false, inputB)).toBe(true);
  });
});
