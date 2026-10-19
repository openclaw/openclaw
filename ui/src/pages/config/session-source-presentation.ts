import type { ImportGlobFunction } from "vite/types/importGlob.js";

declare global {
  interface ImportMeta {
    glob: ImportGlobFunction;
  }
}

export type SessionSourcePresentation = {
  pluginId: string;
  plugin: string;
  icon: string;
  key: string;
  labelKey: string;
  order: number;
};

// Static display facts are also needed by Settings search before this page loads.
const presentations = import.meta.glob<SessionSourcePresentation>(
  "../../../../extensions/*/control-ui.session-source.json",
  { eager: true, import: "default" },
);

export const sessionSourcePresentations = Object.values(presentations).toSorted(
  (left, right) => left.order - right.order,
);
