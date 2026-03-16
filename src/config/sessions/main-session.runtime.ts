import { loadConfig } from "../io.js";
import { resolveMainSessionKey } from "./main-session.js";

export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(loadConfig());
}
