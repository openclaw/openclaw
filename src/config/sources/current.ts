/**
 * Process-level current config source. Gateway sets this at startup so
 * readConfigFileSnapshot() and the config reloader use the resolved source
 * (file or Nacos). Import only types from ./types.js to avoid cycles.
 */

import type { ConfigSource } from "./types.js";

let currentSource: ConfigSource | null = null;

export function setConfigSource(source: ConfigSource | null): void {
  currentSource = source;
}

export function getConfigSource(): ConfigSource | null {
  return currentSource;
}
