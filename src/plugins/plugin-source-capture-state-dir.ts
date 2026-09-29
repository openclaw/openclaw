import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { pluginSourceCaptureStateDir } from "./plugin-source-capture-context.js";

export function resolvePluginSourceCaptureStateDir(stateDir?: string): string {
  return path.resolve(stateDir ?? pluginSourceCaptureStateDir.getStore() ?? resolveStateDir());
}
