import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";

export type BoardWriteOutcome<T> = { value: T; changes: SessionRowChange[] };

export type BoardWriteOperations = {
  "boards.applyOps": {
    input: { sessionKey: string; ops: readonly BoardOp[] };
    output: BoardWriteOutcome<BoardSnapshot>;
  };
  "boards.putWidget": {
    input: { sessionKey: string; params: BoardWidgetMaterializedPutParams; viewGeneration: string };
    output: BoardWriteOutcome<BoardWidgetPutResult>;
  };
  "boards.grant": {
    input: {
      sessionKey: string;
      name: string;
      decision: "granted" | "rejected";
      revision: number;
      instanceId?: string;
    };
    output: BoardWriteOutcome<BoardSnapshot>;
  };
};
