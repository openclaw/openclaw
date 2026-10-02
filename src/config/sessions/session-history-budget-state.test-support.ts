import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

export function installHistoryBudgetState(
  prefix: string,
  setup: (state: OpenClawTestState, tempDir: string, storePath: string) => void,
  overrideTmp = true,
) {
  let state: OpenClawTestState;
  let storePath: string;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix, layout: "state-only" });
    if (overrideTmp) {
      vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(state.root);
    }
    const tempDir = state.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
    setup(state, tempDir, storePath);
  });
  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });
}
