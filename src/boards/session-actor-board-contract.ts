import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import type {
  BoardSnapshotWithHtmlViewMetadata,
  BoardWidgetDocument,
  BoardWidgetNameIdentityMarker,
} from "./board-store.js";

export type SessionActorMemoryBoard = {
  snapshot: BoardSnapshot;
  content: Map<
    string,
    {
      content: BoardWidgetMaterializedPutParams["content"];
      nameIdentity: BoardWidgetNameIdentityMarker;
      sha256?: string;
    }
  >;
};

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
export type SessionActorBoardQuery = {
  [Key in keyof SessionActorBoardReads]: { type: Key; input: SessionActorBoardReads[Key]["input"] };
}[keyof SessionActorBoardReads];
export type SessionActorBoardCommand = {
  [Key in keyof SessionActorBoardWrites]: {
    type: Key;
    input: SessionActorBoardWrites[Key]["input"];
  };
}[keyof SessionActorBoardWrites];
