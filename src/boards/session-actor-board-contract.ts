import type {
  BoardOp,
  BoardMcpAppDescriptor,
  BoardWidgetDeclared,
  BoardWidgetGeneratedIdentity,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";

type BoardWidgetHtmlDocument = {
  html: string;
  revision: number;
  sha256: string;
  viewGeneration: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declared?: BoardWidgetDeclared;
  resourceOrigins?: string[];
};
export type BoardWidgetHtmlViewMetadata = Omit<BoardWidgetHtmlDocument, "html">;
export type BoardWidgetMcpAppDocument = {
  descriptor: BoardMcpAppDescriptor;
  revision: number;
  instanceId: string;
  grantState: "none" | "pending" | "granted" | "rejected";
  declaredTools: string[];
  interactive: boolean;
};
export type BoardWidgetDocument = BoardWidgetHtmlDocument | BoardWidgetMcpAppDocument;
export type BoardSnapshotWithHtmlViewMetadata = {
  snapshot: BoardSnapshot;
  htmlViewMetadata: ReadonlyMap<string, BoardWidgetHtmlViewMetadata>;
};

type BoardWidgetGeneratedIdentityMarker = Pick<BoardWidgetGeneratedIdentity, "source" | "key"> & {
  kind: "generated";
};
export type BoardWidgetNameIdentityMarker =
  | { kind: "explicit" }
  | BoardWidgetGeneratedIdentityMarker
  | { kind: "invalid" };

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
