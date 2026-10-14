import type { ImportGlobFunction } from "vite/types/importGlob.js";

declare global {
  interface ImportMeta {
    glob: ImportGlobFunction;
  }
}

type MemoryAddonPresentation = {
  pluginId: string;
  memoryAddon: { order: number; labelKey: string };
};

// Bundled presentation is available before the runtime plugin catalog loads.
const presentations = import.meta.glob<MemoryAddonPresentation>(
  "../../../../extensions/*/control-ui.presentation.json",
  { eager: true, import: "default" },
);

export const memoryAddonPresentations = Object.values(presentations)
  .toSorted((left, right) => left.memoryAddon.order - right.memoryAddon.order)
  .map(({ pluginId, memoryAddon }) => ({ id: pluginId, labelKey: memoryAddon.labelKey }));
