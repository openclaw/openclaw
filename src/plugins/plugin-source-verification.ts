import fs from "node:fs";
import { acquirePluginSource } from "./plugin-instance-error.js";
import { isPluginSourceEntry } from "./plugin-source-file.js";

export function readPluginSourceDirectory(source: string, originalSource = true) {
  return acquirePluginSource(() => fs.readdirSync(source), originalSource)
    .filter(isPluginSourceEntry)
    .toSorted();
}

export type PluginCapturedSourceFact = {
  contentHash: string;
  sizeBytes: number;
  /** Normalized private file mode when the capture retains complete source facts. */
  mode?: number;
};
