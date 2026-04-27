import { loadConfig } from "../io.js";
import { resolveMainSessionKey } from "./main-session.js";
export function resolveMainSessionKeyFromConfig() {
    return resolveMainSessionKey(loadConfig());
}
