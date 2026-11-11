import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import type { SessionDiffOwner, SessionDiffScope } from "./chat-sidebar-content-types.ts";

export type FileSource = {
  parsed: ParsedFilePatch | null;
  expandedGaps?: Map<DiffLine, Set<DiffLine>>;
};
export type FileView = { file: SessionDiffFile; source: FileSource };
export type DiffValue = {
  owner: SessionDiffOwner | null;
  scope: SessionDiffScope;
  result: SessionsDiffResult;
  views: FileView[];
};
