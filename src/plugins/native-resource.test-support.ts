import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function nativeFixtureEnv(dir: string, stateDir = dir) {
  return {
    OPENCLAW_HOME: dir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
  };
}

export function cleanupNativeFixture(
  key: string,
  connections: Iterable<{ database: Pick<DatabaseSync, "isOpen" | "close"> }>,
) {
  for (const { database } of connections) {
    if (database.isOpen) {
      database.close();
    }
  }
  Reflect.deleteProperty(globalThis, key);
}
