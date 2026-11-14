import path from "node:path";
import { resolveConfigDir } from "../infra/config-dir.js";

export function getMediaDir() {
  return path.join(resolveConfigDir(), "media");
}
