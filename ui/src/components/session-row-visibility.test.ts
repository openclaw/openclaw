import { describe, expect, it } from "vitest";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

const quietRow = {
  visuallyActive: false,
  containsActiveDescendant: false,
  hasActiveRun: false,
  status: "done",
  runningChildCount: 0,
  attention: { kind: "none" },
} as SidebarRecentSession;

type State = [string, Partial<SidebarRecentSession>, boolean, boolean, boolean];
const states: State[] = [
  ["quiet", {}, false, false, false],
  ["visually active", { visuallyActive: true }, true, false, false],
  ["active descendant", { containsActiveDescendant: true }, true, false, false],
  ["active run", { hasActiveRun: true }, true, true, false],
  ["running status", { status: "running" }, true, false, false],
  ["running descendant", { runningChildCount: 1 }, true, false, false],
  ["attention", { attention: { kind: "question" } }, true, false, true],
];

describe("sidebar row visibility demand", () => {
  for (const [name, patch, cap, runningDot, attention] of states) {
    it(`keeps cap, collapsed-dot, and bubbling decisions aligned for ${name}`, () => {
      const row = { ...quietRow, ...patch };
      expect({
        cap: rowDemandsVisibility(row),
        runningDot: rowDemandsVisibility(row, RowVisibilityReason.ActiveRun),
        attentionDot: rowDemandsVisibility(row, RowVisibilityReason.Attention),
        attentionBubble: rowDemandsVisibility(row, RowVisibilityReason.Attention),
      }).toEqual({
        cap,
        runningDot,
        attentionDot: attention,
        attentionBubble: attention,
      });
    });
  }
});
