import type { JSX } from "@solidjs/web";
import type { ArtifactSummary } from "../../../../../packages/gateway-protocol/src/schema/artifacts.js";
import type { SessionWorkspaceArtifacts } from "./chat-session-workspace-types.ts";

export type ChatOutputsDashboard = {
  title: string;
  onOpen: () => void;
};

type ChatOutputsData = {
  /** The complete artifacts.list({ sessionKey, messageRole: "assistant" }) result. */
  artifacts: readonly ArtifactSummary[] | null;
  artifactRead?: SessionWorkspaceArtifacts;
  artifactsError: string | null;
  /** undefined: not resolved; null: confirmed absent. Not one entry per widget. */
  dashboard: ChatOutputsDashboard | null | undefined;
  dashboardError: string | null;
  /** Readiness of the acquired provider; observes its existing snapshot request. */
  dashboardRead?: Promise<void>;
};

export type ChatOutputsProps = ChatOutputsData & {
  onOpenArtifact: (artifactId: ArtifactSummary["id"]) => void;
  onRetryArtifacts?: () => void;
  onRetryDashboard?: () => void;
  /** Use the original filename when the native owner has it; never infer an extension. */
  getArtifactName?: (artifact: ArtifactSummary) => string;
  /** Native icon owner supplies the document/table geometry for this artifact. */
  renderArtifactIcon: (artifact: ArtifactSummary) => JSX.Element;
};

export type ChatOutputsDesktopProps = ChatOutputsProps & {
  /** Select the existing Files catalog, even if a preview is currently active. */
  onViewAll: () => void;
  /** The approved Folders glyph, supplied by the shared icon owner. */
  renderViewAllIcon: () => JSX.Element;
};

/** Shared by the root entry and its interior; unknown is not a zero count. */
export function getChatOutputsCount(data: ChatOutputsData): number | null {
  if (data.artifacts === null || data.dashboard === undefined) {
    return null;
  }
  return data.artifacts.length + (data.dashboard === null ? 0 : 1);
}

/** Optional desktop sections need content or an actionable read error, not a speculative slot. */
export function hasChatDesktopOutputs(data: ChatOutputsData): boolean {
  return Boolean(
    data.artifacts?.length || data.dashboard || data.artifactsError || data.dashboardError,
  );
}
