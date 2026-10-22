import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createAgentAccountingPersistenceFixture } from "./agent-runner-result-accounting.persistence.test-support.js";

export function createDeliverySuite() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const operations: ReplyOperation[] = [];
  let suiteRoot: string;
  let storePath: string;
  let fixtureSequence = 0;
  beforeAll(() => {
    // openclaw-temp-dir: allow suite database root drains before removal
    suiteRoot = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-accounting-suite-"),
    );
    storePath = path.join(suiteRoot, "openclaw-agent.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  });
  afterAll(async () => {
    await drainSessionStoreWriterQueuesForTest();
    await disposeOpenClawAgentDatabaseByPath(storePath);
    await closeOpenClawAgentDatabasesAsync(suiteRoot);
    expect(isOpenClawAgentDatabaseOpen(storePath)).toBe(false);
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const operation of operations.splice(0)) {
      operation.complete();
    }
  });
  return {
    get storePath() {
      return storePath;
    },
    createFixture: () =>
      createAgentAccountingPersistenceFixture({
        storePath,
        root: tempDirs.make("openclaw-context-pressure-"),
        fixtureId: ++fixtureSequence,
        registerOperation: (operation) => {
          operations.push(operation);
        },
      }),
    async reopen() {
      await drainSessionStoreWriterQueuesForTest();
      await disposeOpenClawAgentDatabaseByPath(storePath);
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    },
  };
}
