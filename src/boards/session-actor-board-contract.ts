import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { BoardSnapshotWithHtmlViewMetadata, BoardWidgetDocument } from "./board-store.js";

export type SessionActorBoardReads = {
  "boards.snapshot": {
    input: { sessionKey: string };
    output: BoardSnapshotWithHtmlViewMetadata;
  };
  "boards.document": {
    input: { sessionKey: string; name: string; contentKind?: "mcp-app" };
    output: BoardWidgetDocument | undefined;
  };
};
export type SessionActorBoardWrites = {
  "boards.applyOps": {
    input: { sessionKey: string; ops: readonly BoardOp[] };
    output: BoardSnapshot;
  };
  "boards.putWidget": {
    input: { sessionKey: string; params: BoardWidgetMaterializedPutParams; viewGeneration: string };
    output: BoardWidgetPutResult;
  };
  "boards.grant": {
    input: {
      sessionKey: string;
      name: string;
      decision: "granted" | "rejected";
      revision: number;
      instanceId?: string;
    };
    output: BoardSnapshot;
  };
};
