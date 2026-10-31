import { beforeEach, expect, it } from "vitest";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
import { attachEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import {
  createSourceReplyBatchCompletion,
  ToolSourceReplyCell,
} from "./tool-source-reply-completion.js";

function deliveredResult(
  fact: Partial<Parameters<typeof attachEmbeddedMessageDeliveryFact>[1]> = {},
) {
  return attachEmbeddedMessageDeliveryFact(
    { content: [], details: {} },
    {
      status: "settled",
      sourceReplyDelivered: true,
      partialDelivery: false,
      createdThreadIds: [],
      ...fact,
    },
  );
}

const inputA = {};
const inputB = {};
let owner: ReturnType<typeof createSourceReplyBatchCompletion>;
beforeEach(() => {
  owner = createSourceReplyBatchCompletion();
});
function expectCompletion(
  expected: boolean,
  results: object[],
  directFinal = false,
  input = inputA,
) {
  expect(owner.complete(results, directFinal, input)).toBe(expected);
}
const waiting = (cell: ToolSourceReplyCell, input = inputA) => cell.attach({}, "waiting", input);
const settled = (cell: ToolSourceReplyCell, input = inputA) => cell.attach({}, "completed", input);
function deliveredCell(input = inputA) {
  const cell = new ToolSourceReplyCell(input);
  cell.observe(deliveredResult());
  return cell;
}

it("does not accept public delivery or cell fields as completion authority", () => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(structuredClone(deliveredResult()));
  expectCompletion(false, [settled(cell)]);
  expectCompletion(false, [{ finalDelivered: true, settled: true, terminate: true }]);
});

it.each([
  { sourceReplyDelivered: undefined },
  { partialDelivery: true },
  { status: "dryRun" },
  { status: "failed" },
] as const)("does not complete progress, partial, dry-run or failed delivery: %j", (fact) => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(deliveredResult(fact));
  expectCompletion(false, [settled(cell)]);
});

it("preserves delivered authority through private transforms and guest failure", () => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(copyInternalToolResultState(deliveredResult(), {}));
  const result = cell.attach({}, "failed", inputA);
  owner.observe(result);
  // The actual after-tool hook can fail after observing the committed control.
  expectCompletion(true, [{ isError: true }]);
  expectCompletion(false, [copyInternalToolResultState(result, {})]);
});

it("joins additional sibling cells without losing the original batch", () => {
  const reply = deliveredCell();
  const sibling = new ToolSourceReplyCell(inputA);
  const laterSibling = new ToolSourceReplyCell(inputA);
  expectCompletion(false, [waiting(reply), waiting(sibling)]);
  expectCompletion(false, [settled(reply), waiting(laterSibling)]);
  expectCompletion(false, [waiting(sibling)]);
  expectCompletion(false, [settled(sibling)]);
  expectCompletion(true, [settled(laterSibling)]);
  expectCompletion(false, [settled(reply)]);
});

it("does not transfer finality to an unrelated batch", () => {
  const reply = deliveredCell();
  expectCompletion(false, [waiting(reply)]);
  expectCompletion(false, [settled(new ToolSourceReplyCell(inputA))]);
  expectCompletion(true, [settled(reply)]);
});

it("disarms an old batch when accepted steering precedes its eventual wait", () => {
  const reply = deliveredCell();
  const sibling = new ToolSourceReplyCell(inputA);
  expectCompletion(false, [settled(reply), waiting(sibling)], true, inputA);
  expectCompletion(false, [settled(sibling, inputB)], false, inputB);
  expectCompletion(false, [settled(reply, inputB)], false, inputB);
  expect(reply.finalDelivered).toBe(true);
});

it("keeps a direct final reply pending behind an unfinished cell", () => {
  const sibling = new ToolSourceReplyCell(inputA);
  expectCompletion(false, [waiting(sibling)], true);
  expectCompletion(true, [settled(sibling)]);
});

it.each([false, true])(
  "keeps failed-publication observations scoped to their input (new input=%s)",
  (newInput) => {
    const cell = deliveredCell();
    owner.observe(settled(cell));
    // Result publication failed before complete() could enroll the observation.
    expectCompletion(!newInput, [], false, newInput ? {} : inputA);
    expect(cell.finalDelivered).toBe(true);
  },
);

it("does not enroll a late old-input observation in a new input's batch", () => {
  const oldCell = new ToolSourceReplyCell(inputA);
  const newCell = new ToolSourceReplyCell(inputB);
  expectCompletion(false, [], false, inputB);
  oldCell.observe(deliveredResult());
  owner.observe(waiting(oldCell));
  newCell.observe(deliveredResult());
  expectCompletion(true, [settled(newCell, inputB)], false, inputB);
  expect(oldCell.finalDelivered).toBe(true);
  expect(oldCell.settled).toBe(false);
});

it("does not reassign an old cell's final reply when a new input waits on it", () => {
  const oldCell = deliveredCell();
  expectCompletion(false, [settled(oldCell, inputB)], false, inputB);
  expect(oldCell.finalDelivered).toBe(true);
});

it("joins an old cell waited by the current batch before consuming its fresh final reply", () => {
  const oldCell = deliveredCell();
  const newCell = deliveredCell(inputB);
  expectCompletion(false, [waiting(oldCell, inputB), settled(newCell, inputB)], false, inputB);
  expectCompletion(false, [waiting(oldCell, inputB)], false, inputB);
  expectCompletion(true, [settled(oldCell, inputB)], false, inputB);
});
