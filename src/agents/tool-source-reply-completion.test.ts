import { beforeEach, expect, it, vi } from "vitest";
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

const inputA = {};
let owner: ReturnType<typeof createSourceReplyBatchCompletion>;
beforeEach(() => {
  owner = createSourceReplyBatchCompletion();
});
const complete = (results: object[], directFinal = false, input = inputA) =>
  owner.complete(results, directFinal, input);
const attach = (
  cell: ToolSourceReplyCell,
  status: "waiting" | "completed" | "failed",
  input = inputA,
) => cell.attach({}, status, input);
function deliveredCell(input = inputA) {
  const cell = new ToolSourceReplyCell(input);
  cell.observe(deliveredResult());
  return cell;
}

it("does not accept public delivery or cell fields as completion authority", () => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(structuredClone(deliveredResult()));
  expect(complete([attach(cell, "completed")])).toBe(false);
  expect(complete([{ finalDelivered: true, settled: true, terminate: true }])).toBe(false);
});

it.each([
  { status: "settled" as const, partialDelivery: false, sourceReplyDelivered: undefined },
  { status: "settled" as const, partialDelivery: true, sourceReplyDelivered: true as const },
  { status: "dryRun" as const, partialDelivery: false, sourceReplyDelivered: true as const },
  { status: "failed" as const, partialDelivery: false, sourceReplyDelivered: true as const },
])("does not complete progress, partial, dry-run or failed delivery: %j", (fact) => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(
    attachEmbeddedMessageDeliveryFact(
      { content: [], details: {} },
      { ...fact, createdThreadIds: [] },
    ),
  );
  expect(complete([attach(cell, "completed")])).toBe(false);
});

it("preserves delivered authority through private transforms and guest failure", () => {
  const cell = new ToolSourceReplyCell(inputA);
  cell.observe(copyInternalToolResultState(deliveredResult(), {}));
  const result = attach(cell, "failed");
  owner.observe(result);
  // The actual after-tool hook can fail after observing the committed control.
  expect(complete([{ isError: true }])).toBe(true);
  expect(complete([copyInternalToolResultState(result, {})])).toBe(false);
});

it("holds finality across exec/wait until every sibling cell settles", () => {
  const reply = deliveredCell();
  const sibling = new ToolSourceReplyCell(inputA);
  expect(complete([attach(reply, "completed"), attach(sibling, "waiting")])).toBe(false);
  expect(complete([attach(sibling, "waiting")])).toBe(false);
  expect(complete([attach(sibling, "completed")])).toBe(true);
  expect(complete([attach(reply, "completed")])).toBe(false);
});

it("settles a tool batch without additional materialization passes over its cells", () => {
  const cells = Array.from({ length: 64 }, () => new ToolSourceReplyCell(inputA));
  cells[0]!.observe(deliveredResult());
  const results = cells.map((cell) => attach(cell, "completed"));
  const iterate = Set.prototype[Symbol.iterator];
  let visits = 0;
  const iterator = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function* (
    this: Set<unknown>,
  ) {
    for (const value of iterate.call(this)) {
      visits += 1;
      yield value;
    }
    return undefined;
  });
  let completed: boolean;
  try {
    completed = complete(results);
  } finally {
    iterator.mockRestore();
  }
  expect(completed).toBe(true);
  // Enroll observations, join/evaluate cells, and consume the settled batch.
  expect(visits).toBeLessThanOrEqual(cells.length * 3);
  expect(complete(results)).toBe(false);
});

it("joins additional sibling cells without losing the original batch", () => {
  const reply = deliveredCell();
  const sibling = new ToolSourceReplyCell(inputA);
  const laterSibling = new ToolSourceReplyCell(inputA);
  expect(complete([attach(reply, "waiting"), attach(sibling, "waiting")])).toBe(false);
  expect(complete([attach(reply, "completed"), attach(laterSibling, "waiting")])).toBe(false);
  expect(complete([attach(sibling, "completed")])).toBe(false);
  expect(complete([attach(laterSibling, "completed")])).toBe(true);
});

it("does not transfer finality to an unrelated batch", () => {
  const reply = deliveredCell();
  expect(complete([attach(reply, "waiting")])).toBe(false);
  expect(complete([attach(new ToolSourceReplyCell(inputA), "completed")])).toBe(false);
  expect(complete([attach(reply, "completed")])).toBe(true);
});

it("disarms an old batch when accepted steering precedes its eventual wait", () => {
  const reply = deliveredCell();
  const sibling = new ToolSourceReplyCell(inputA);
  const inputB = {};
  expect(complete([attach(reply, "completed"), attach(sibling, "waiting")], true, inputA)).toBe(
    false,
  );
  expect(complete([attach(sibling, "completed", inputB)], false, inputB)).toBe(false);
  expect(complete([attach(reply, "completed", inputB)], false, inputB)).toBe(false);
  expect(reply.finalDelivered).toBe(true);
});

it("keeps a direct final reply pending behind an unfinished cell", () => {
  const sibling = new ToolSourceReplyCell(inputA);
  expect(complete([attach(sibling, "waiting")], true)).toBe(false);
  expect(complete([attach(sibling, "completed")])).toBe(true);
});

it.each([false, true])(
  "keeps failed-publication observations scoped to their input (new input=%s)",
  (newInput) => {
    const cell = deliveredCell();
    owner.observe(attach(cell, "completed"));
    // Result publication failed before complete() could enroll the observation.
    expect(complete([], false, newInput ? {} : inputA)).toBe(!newInput);
    expect(cell.finalDelivered).toBe(true);
  },
);

it("does not enroll a late old-input observation in a new input's batch", () => {
  const inputB = {};
  const oldCell = new ToolSourceReplyCell(inputA);
  const newCell = new ToolSourceReplyCell(inputB);
  expect(complete([], false, inputB)).toBe(false);
  oldCell.observe(deliveredResult());
  owner.observe(attach(oldCell, "waiting"));
  newCell.observe(deliveredResult());
  expect(complete([attach(newCell, "completed", inputB)], false, inputB)).toBe(true);
  expect(oldCell.finalDelivered).toBe(true);
  expect(oldCell.settled).toBe(false);
});

it("does not reassign an old cell's final reply when a new input waits on it", () => {
  const inputB = {};
  const oldCell = deliveredCell();
  expect(complete([attach(oldCell, "completed", inputB)], false, inputB)).toBe(false);
  expect(oldCell.finalDelivered).toBe(true);
});

it("joins an old cell waited by the current batch before consuming its fresh final reply", () => {
  const inputB = {};
  const oldCell = deliveredCell();
  const newCell = deliveredCell(inputB);
  expect(
    complete(
      [attach(oldCell, "waiting", inputB), attach(newCell, "completed", inputB)],
      false,
      inputB,
    ),
  ).toBe(false);
  expect(complete([attach(oldCell, "waiting", inputB)], false, inputB)).toBe(false);
  expect(complete([attach(oldCell, "completed", inputB)], false, inputB)).toBe(true);
});
