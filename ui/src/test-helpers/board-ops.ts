import type { BoardOp, BoardSnapshot } from "@openclaw/gateway-protocol";
import {
  applyBoardOps,
  BoardValidationError,
  normalizeBoardLayout,
} from "../../../src/boards/board-layout.ts";

export function normalizeMockBoardSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return { ...snapshot, ...normalizeBoardLayout(snapshot) };
}

export function applyMockBoardOp(snapshot: BoardSnapshot, op: BoardOp): BoardSnapshot {
  try {
    return { ...snapshot, ...applyBoardOps(snapshot, [op]) };
  } catch (error) {
    // UI fixtures historically treat invalid operations as no-ops, not rejected RPCs.
    if (error instanceof BoardValidationError) {
      return snapshot;
    }
    throw error;
  }
}
