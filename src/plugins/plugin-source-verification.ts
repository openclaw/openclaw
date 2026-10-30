import fs from "node:fs";
import { isPluginSourceEntry } from "./plugin-source-file.js";

export function readPluginSourceDirectory(source: string) {
  return fs.readdirSync(source).filter(isPluginSourceEntry).toSorted();
}

export type PluginCapturedSourceFact = {
  contentHash: string;
  sizeBytes: number;
};
