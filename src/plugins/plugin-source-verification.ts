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
};
