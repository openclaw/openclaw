import type { JSX } from "@solidjs/web";
import type { Accessor } from "solid-js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { SessionDiffGapDirection } from "../../../lib/chat/session-diff-gaps.ts";
import type { pairSessionDiffLines } from "../../../lib/chat/session-diff-split.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import type { DiffPresentation } from "./chat-diff-render.solid.tsx";
import type { SessionDiffScope, SessionDiffProps } from "./chat-sidebar-content-types.ts";
import type {
  SessionDiffMenuAction,
  SessionDiffDesktopMenuAction,
  SessionDiffMenuDraft,
} from "./session-diff-menus.tsx";
import type { SessionDiffMode } from "./session-diff-preferences.ts";
import type { SessionDiffSyncMobileData } from "./session-diff-sync-mobile.tsx";
import type { DiffValue, FileView } from "./session-diff-types.ts";

export type SessionDiffViewBindings = {
  props: SessionDiffProps;
  desktop: Accessor<boolean>;
  mobile: Accessor<boolean>;
  collapsedPaths: Accessor<Set<string>>;
  scope: Accessor<SessionDiffScope>;
  split: Accessor<boolean>;
  wrap: Accessor<boolean>;
  mobileWrap: Accessor<boolean>;
  mode: Accessor<SessionDiffMode>;
  wordDiffs: Accessor<boolean>;
  selectedPath: Accessor<string | null>;
  treeOpen: Accessor<boolean>;
  treeSearchOpen: Accessor<boolean>;
  treeQuery: Accessor<string>;
  motionInstant: Accessor<boolean>;
  value: Accessor<DiffValue | null>;
  syncData: Accessor<SessionDiffSyncMobileData | null>;
  loading: Accessor<boolean>;
  gapRevision: Accessor<number>;
  pairedRows: Accessor<Map<FileView, ReturnType<typeof pairSessionDiffLines>>>;
  effectiveSplit: Accessor<boolean>;
  toggleFile: (path: string) => void;
  toggleTree: () => void;
  searchTree: () => void;
  jumpToFile: (path: string) => void;
  openAnchoredMenu: (
    event: Event,
    draft: SessionDiffMenuDraft,
    placement?: "bottom-end" | "bottom-start" | "top-start",
  ) => void;
  handleMenuAction: (action: SessionDiffMenuAction | SessionDiffDesktopMenuAction) => void;
  scopeTitle: (result?: SessionsDiffResult) => string;
  loadDiff: () => void;
  expandGap: (view: FileView, line: DiffLine, direction: SessionDiffGapDirection) => Promise<void>;
  canExpandGaps: (view: FileView) => boolean;
  collapseGap: (view: FileView, line: DiffLine) => void;
  registerPresentation: (path: string, presentation: DiffPresentation) => () => void;
  registerFileElement: (path: string, element: HTMLElement) => void;
  setTreeSearch: (element: HTMLInputElement) => void;
  setTreeSearchTrigger: (element: HTMLButtonElement) => void;
  setTreeQuery: (query: string) => void;
  setWide: (wide: boolean) => void;
  closeTreeSearch: () => void;
  refreshCollapsed: () => void;
  renderMobileSync: () => JSX.Element;
};

export const FILE_STATUS_LABELS = {
  added: ["A", "chat.sessionDiff.statusAdded"],
  deleted: ["D", "chat.sessionDiff.statusDeleted"],
  renamed: ["R", "chat.sessionDiff.statusRenamed"],
  modified: ["M", "chat.sessionDiff.statusModified"],
} as const;
export function diffStat(file: Pick<SessionDiffFile, "additions" | "deletions">) {
  const modified = Math.min(file.additions, file.deletions);
  return { added: file.additions - modified, removed: file.deletions - modified, modified };
}
export function totalDiffStat(files: readonly SessionDiffFile[]) {
  const total = { added: 0, removed: 0, modified: 0 };
  for (const file of files) {
    const stat = diffStat(file);
    total.added += stat.added;
    total.removed += stat.removed;
    total.modified += stat.modified;
  }
  return total;
}
export function splitPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { directory: "", name: normalized }
    : { directory: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}
