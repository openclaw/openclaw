import type { Buffer } from "node:buffer";
import type { LongSessionScenario } from "./control-ui-team-scale-history-fixture.ts";
import type { prepareTeamScalePaneFixture } from "./control-ui-team-scale-pane-fixture.ts";

export type FixtureOptions = Parameters<typeof prepareTeamScalePaneFixture>[0]["options"] & {
  baseUrl?: string;
  now?: number;
  /** Supply the real canvas sandbox fixture for browser/widget measurements. */
  sandboxUrl?: string;
  sandboxPort?: number;
  liveRun?: boolean;
  sidebarListChurn?: boolean;
  sidebarLiveChurn?: boolean;
  sidebarAvatars?: boolean;
  sidebarPresentation?: boolean;
  sidebarCachedParity?: boolean;
  sidebarPersistentChildren?: boolean;
  sessionEventChurn?: boolean;
  sessionEventDurationMs?: number;
  sessionEventAncestorRefs?: boolean;
  duplicateBootReads?: boolean;
  closedMenuMembers?: boolean;
  largeSnapshot?: boolean;
  historyStateReceipt?: boolean;
  rowFacts?: boolean;
  offRosterSession?: boolean;
  archivedSession?: boolean;
  /** Ordinary child-session activity outside the Subagents collection. */
  detailsSubagentActivity?: number;
  transcriptMessages?: number;
  richTranscript?: boolean;
  longSessionScenario?: LongSessionScenario;
  dashboardMcpApp?: { font: Buffer };
  /** Opt into a scripted HTML dashboard with an independently fetched web font. */
  dashboardWidgetFontUrl?: string;
  dashboardPaintMarker?: boolean;
};
