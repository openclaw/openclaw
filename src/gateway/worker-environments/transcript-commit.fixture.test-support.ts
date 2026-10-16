import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import {
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  createTranscriptCommitIdentity,
  RUN_EPOCH,
  SESSION_ID,
} from "./transcript-commit.test-support.js";

export const SESSION_KEY = "agent:main:worker-transcript";
export const IDENTITY = createTranscriptCommitIdentity(SESSION_ID, RUN_EPOCH);

export async function createTranscriptCommitFixture(getConfig: () => OpenClawConfig) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-turn-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  let stateDatabasePath: string | undefined;
  const close = async () => {
    try {
      await waitForSessionTranscriptIndexReconcilesInStateDir(root);
      await closeOpenClawAgentDatabasesAsync(root);
      if (stateDatabasePath) {
        await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
      }
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  };
  try {
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      { lifecycleRevision: "worker-original-revision", sessionId: SESSION_ID, updatedAt: 10 },
    );
    const sessionTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    const owner = {
      identity: IDENTITY,
      sessionTarget: { ...sessionTarget, expectedLifecycleRevision: "worker-original-revision" },
      assertCurrent: () => undefined,
    };
    const database = openOpenClawStateDatabase();
    stateDatabasePath = database.path;
    const ledgerStore = createWorkerTranscriptCommitStore({ database });
    const committer = createWorkerTranscriptCommitter({ getConfig, store: ledgerStore });
    return { root, storePath, cfg, sessionTarget, owner, ledgerStore, committer, close };
  } catch (error) {
    await close();
    throw error;
  }
}
