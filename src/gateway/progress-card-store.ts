import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { resolveGatewaySessionDatabase } from "./board-store.js";

export type ProgressCardStore = {
  get(sessionKey: string, agentId?: string): Promise<ProgressCard | null>;
  put(
    sessionKey: string,
    input: {
      markdown?: string;
      steps?: ProgressCardStep[];
      expectedRevision?: number;
      // The storage owner checks authority inside its write transaction.
      assertCurrent?: () => void;
    },
    agentId?: string,
  ): Promise<{ card: ProgressCard | null }>;
};

export const progressCardStore: ProgressCardStore = {
  async get(sessionKey, agentId) {
    const resolved = resolveGatewaySessionDatabase(sessionKey, agentId);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionProgressCard(database.db, resolved.sessionKey),
      resolved,
    );
    return result.found ? result.value : null;
  },
  async put(sessionKey, input, agentId) {
    const resolved = resolveGatewaySessionDatabase(sessionKey, agentId);
    const env = { ...process.env };
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const databaseOptions = {
      ...resolved,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    const assertCurrent = () => {
      input.assertCurrent?.();
      const current = resolveGatewaySessionDatabase(sessionKey, agentId);
      if (
        current.agentId !== resolved.agentId ||
        current.path !== resolved.path ||
        current.sessionKey !== resolved.sessionKey
      ) {
        throw new Error("progress-card session changed; retry");
      }
    };
    assertCurrent();
    const result = await runOpenClawAgentWriteAdmission(
      databaseOptions,
      () =>
        withOpenClawAgentDatabaseAsync(
          databaseOptions,
          () =>
            runOpenClawAgentWriteTransaction(
              (database) => {
                assertCurrent();
                return writeSessionProgressCard(database.db, resolved.sessionKey, input);
              },
              databaseOptions,
              { operationLabel: "progress-card.put" },
            ),
          assertCurrent,
        ),
      true,
    );
    return "card" in result ? result : { card: null };
  },
};
