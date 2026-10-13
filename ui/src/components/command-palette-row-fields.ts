import type { ProjectedSessionRow, SessionRowField } from "../lib/sessions/session-row-fields.ts";

export const COMMAND_PALETTE_ROW_FIELDS = [
  "agentId",
  "label",
  "displayName",
  "derivedTitle",
  "accountId",
  "worktree",
  "repository",
  "execNode",
  "subject",
  "category",
  "model",
  "modelProvider",
  "owner",
  "createdActor",
] as const satisfies readonly SessionRowField[];

export type CommandPaletteSessionRow = ProjectedSessionRow<typeof COMMAND_PALETTE_ROW_FIELDS>;
