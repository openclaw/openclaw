/**
 * Plugin-safe memory search API.
 *
 * Provides access to the memory search manager from plugin code running
 * inside a global OpenClaw install, where direct internal imports are
 * unreliable due to Node module resolution boundaries.
 *
 * Usage:
 *   import { getMemorySearchManager } from "openclaw/plugin-sdk/memory";
 */
export {
  getMemorySearchManager,
  type MemorySearchManagerResult,
} from "../memory/search-manager.js";
