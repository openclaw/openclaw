import { getAgentToolInputScope } from "../../packages/agent-core/src/tool-execution-context.js";
import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "./runtime/internal-hooks.js";

const finalSourceReply = {};
type SourceReplyControl = { cell: ToolSourceReplyCell; inputScope: object | undefined };
const sourceReplyControls = new WeakMap<object, SourceReplyControl>();

/** Only the delivery producer can attest a completed current-source final reply. */
export function markFinalSourceReplyResult<T extends object>(result: T): T {
  return attachInternalToolResultProvenance(result, finalSourceReply);
}

/** One retained cell, shared by exec and every wait that resumes that same cell. */
export class ToolSourceReplyCell {
  finalDelivered = false;
  settled = false;

  constructor(readonly inputScope = getAgentToolInputScope()) {}

  observe(result: object): void {
    this.finalDelivered ||= getInternalToolResultProvenance(result) === finalSourceReply;
  }

  attach<T extends object>(
    result: T,
    status: "waiting" | "completed" | "failed",
    inputScope = getAgentToolInputScope(),
  ): T {
    this.settled = status !== "waiting";
    // A new input may wait on this cell, but cannot adopt its original reply.
    const control = { cell: this, inputScope };
    sourceReplyControls.set(control, control);
    return attachInternalToolResultProvenance(result, control);
  }
}

function readSourceReplyControl(result: object): SourceReplyControl | undefined {
  const provenance = getInternalToolResultProvenance(result);
  return provenance ? sourceReplyControls.get(provenance) : undefined;
}

type PendingReplyBatch = {
  cells: Set<ToolSourceReplyCell>;
  directFinal: boolean;
};

/** Final delivery completes only its settled batch, never an unrelated later input. */
export function createSourceReplyBatchCompletion() {
  const observed = new Set<SourceReplyControl>();
  const consumed = new WeakSet<ToolSourceReplyCell>();
  const batchByCell = new Map<ToolSourceReplyCell, PendingReplyBatch>();
  let acceptedInput: object | undefined;
  const forget = (batch: PendingReplyBatch) => {
    for (const cell of batch.cells) {
      batchByCell.delete(cell);
    }
  };
  return {
    observe(result: object): void {
      const control = readSourceReplyControl(result);
      if (control) {
        observed.add(control);
      }
    },
    complete(results: readonly object[], directFinal: boolean, inputScope: object): boolean {
      let hasDirectFinal = directFinal;
      // An earlier cell may finish after a new input is actually committed.
      // Keep its delivery fact, but never use it to complete that new input.
      if (acceptedInput !== inputScope) {
        for (const cell of batchByCell.keys()) {
          consumed.add(cell);
        }
        batchByCell.clear();
        acceptedInput = inputScope;
      }
      for (const result of results) {
        const control = readSourceReplyControl(result);
        if (control) {
          observed.add(control);
        }
      }
      // Observations can survive failed message publication or arrive late.
      // Only this invocation's input may enroll a cell in the current batch.
      const cells = new Set(
        [...observed]
          .filter((control) => control.inputScope === inputScope)
          .map(({ cell }) => cell),
      );
      observed.clear();
      // A wait may share a new batch with another cell. Preserve every original
      // sibling until all of those owners have returned a settled control result.
      for (const cell of cells) {
        const batch = batchByCell.get(cell);
        if (batch) {
          hasDirectFinal ||= batch.directFinal;
          for (const sibling of batch.cells) {
            cells.add(sibling);
          }
          forget(batch);
        }
      }
      const settled = [...cells].every((cell) => cell.settled);
      const delivered =
        hasDirectFinal ||
        [...cells].some(
          (cell) => cell.inputScope === inputScope && cell.finalDelivered && !consumed.has(cell),
        );
      if (settled) {
        for (const cell of cells) {
          consumed.add(cell);
        }
      } else {
        const batch = { cells, directFinal: hasDirectFinal };
        for (const cell of cells) {
          batchByCell.set(cell, batch);
        }
      }
      return settled && delivered;
    },
  };
}
