import { afterEach } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

/** Release callers before native handles, and native handles before their files. */
export function useAgentDatabaseDirectories(beforeClose: () => void | Promise<void> = () => {}) {
  const directories = createTempDirTracker();
  afterEach(async () => {
    await beforeClose();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    directories.cleanup();
  });
  return directories;
}
