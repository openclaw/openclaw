import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  bindSessionControllerTarget,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { createAgentAccountingPersistenceFixture } from "./agent-runner-result-accounting.persistence.test-support.js";

export function useAccountingFixture(prefix: string) {
  const database = { root: "", storePath: "" };
  beforeAll(() => {
    // openclaw-temp-dir: allow suite database root drains before removal
    database.root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
    database.storePath = path.join(database.root, "openclaw-agent.sqlite");
  });
  afterAll(async () => {
    await drainSessionStoreWriterQueuesForTest();
    await disposeOpenClawAgentDatabaseByPath(database.storePath);
    await closeOpenClawAgentDatabasesAsync(database.root);
    fs.rmSync(database.root, { recursive: true, force: true });
  });
  const operations: ReplyOperation[] = [];
  let sequence = 0;
  afterEach(() => {
    for (const operation of operations.splice(0)) {
      operation.complete();
    }
  });
  return {
    database,
    createFixture: () =>
      createAgentAccountingPersistenceFixture({
        ...database,
        fixtureId: ++sequence,
        registerOperation: (operation) => {
          bindSessionControllerTarget(
            operation,
            captureSessionTarget({
              storeScope: database.storePath,
              sessionKey: operation.key,
              agentId: "main",
              incarnation: operation.sessionId,
            }),
          );
          operations.push(operation);
        },
      }),
  };
}
