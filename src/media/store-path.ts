import path from "node:path";
import { resolveConfigDir } from "../infra/config-dir.js";

export function getMediaDir(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveConfigDir(env), "media");
}
