import type { ImportGlobFunction } from "vite/types/importGlob.js";

declare global {
  interface ImportMeta {
    glob: ImportGlobFunction;
  }
}

export type ChannelDetailPresentation = {
  pluginId: string;
  titleKey: string;
  subtitleKey: string;
  extraFacts?: ("credential" | "audience" | "baseUrl" | "mode")[];
  runningWhenStatusMissing?: "unknown";
  accounts?: {
    minimumCount: number;
    titleSource: "botUsername" | "name";
    showConfigured: boolean;
    status: "running" | "runningOrConfigured";
  };
};

// Bundled display facts remain available before channel discovery or activation.
const presentations = import.meta.glob<ChannelDetailPresentation>(
  "../../../../extensions/*/control-ui.channel-detail.json",
  { eager: true, import: "default" },
);

export const channelDetailPresentations = new Map(
  Object.values(presentations).map((presentation) => [presentation.pluginId, presentation]),
);
