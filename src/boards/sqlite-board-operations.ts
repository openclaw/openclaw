import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import type { BoardSnapshotWithHtmlViewMetadata, BoardWidgetDocument } from "./board-store.js";
import type { BoardComponentTarget } from "./component-conversation.js";

export type BoardWriteOutcome<T> = { value: T; changes: SessionRowChange[] };

export type BoardReadOperations = {
  "boards.readSnapshot": {
    input: { sessionKey: string };
    output: BoardSnapshotWithHtmlViewMetadata | undefined;
  };
  "boards.readWidgetDocument": {
    input: { sessionKey: string; name: string; contentKind?: "mcp-app" };
    output: BoardWidgetDocument | undefined;
  };
};

export type BoardWriteOperations = {
  "boards.ensureComponentIdentity": {
    input: { sessionKey: string; name: string; instanceId: string; proposedId: string };
    output: BoardWriteOutcome<{ id: string; title: string }>;
  };
  "boards.applyOps": {
    input: { sessionKey: string; ops: readonly BoardOp[]; component?: BoardComponentTarget };
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
