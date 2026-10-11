import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDispatchReplyOperationCoordinator } from "../../auto-reply/reply/dispatch-from-config.lifecycle.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { SessionWorkerPlacementContext } from "../worker-environments/session-placement-lifecycle.js";
import {
  prepareSessionPatchArchive,
  releaseSessionPatchArchive,
} from "./sessions-patch-archive.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
type PlacementContext = Pick<SessionWorkerPlacementContext, "workerSessionPlacementService">;
let storePath: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  env = { OPENCLAW_STATE_DIR: dirs.make("archive-incognito-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
});
afterAll(() => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  vi.unstubAllEnvs();
});

function archive(key: string, entry: SessionEntry, placement: PlacementContext = {}) {
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg, ...placement });
  return prepareSessionPatchArchive({
    cfg,
    context,
    commitGuard: () => undefined,
    loadGatewayModelCatalogSnapshot: () => context.loadGatewayModelCatalogSnapshot(),
    target: {
      archiveActor: undefined,
      canonicalKey: key,
      fullPatch: { key, archived: true, expectedSessionId: entry.sessionId },
      initialEntry: entry,
      initialStoreKeys: [key],
      key,
      lifecycleIdentities: [key, entry.sessionId],
      requestedAgentId: "main",
      storePath,
    },
  });
}

async function restore(key: string, entry: SessionEntry, placement: PlacementContext = {}) {
  const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
  const selected = { entry, storePath };
  const coordinator = createDispatchReplyOperationCoordinator({
    agentId: "main",
    cfg,
    ctx: buildTestCtx({ SessionKey: key, InboundAccessAuthorized: true, Body: "continue" }),
    dispatcher,
    dispatchOperationSessionKey: key,
    operationSessionStoreEntry: selected,
    sessionWorkerPlacementContext: placement,
    resolveOperationExpectedSessionId: () => entry.sessionId,
  });
  try {
    await coordinator.ensureDispatchReplyOperation("pre_dispatch");
    return selected.entry;
  } finally {
    coordinator.completeDispatchReplyOperation();
    await coordinator.releasePreDispatchLifecycleAdmission();
    dispatcher.markComplete();
  }
}

it("prepares archive and restores an admitted human turn without opening host SQLite", async () => {
  const key = "agent:main:dashboard:incognito-archive";
  const entry: SessionEntry = {
    sessionId: "archive",
    updatedAt: Date.now(),
    incognito: true,
    archivedAt: 1,
  };
  await replaceSessionEntry({ sessionKey: key, storePath }, entry);
  const sql = observeHostDataSql();
  try {
    const prepared = await archive(key, entry);
    assert(prepared.ok, "archive preparation failed");
    expect(prepared.value.entry).toMatchObject(entry);
    releaseSessionPatchArchive(prepared.value);
    expect(await restore(key, entry)).toMatchObject({ sessionId: entry.sessionId });
    expect(loadSessionEntry({ sessionKey: key, storePath })?.archivedAt).toBeUndefined();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it.each(["archive", "restore"] as const)(
  "refuses %s after its same-ID row changes lifecycle during placement preparation",
  async (operation) => {
    const key = `agent:main:dashboard:incognito-${operation}-replacement`;
    const entry: SessionEntry = {
      sessionId: operation,
      updatedAt: Date.now(),
      incognito: true,
      archivedAt: 1,
    };
    await replaceSessionEntry({ sessionKey: key, storePath }, entry);
    const entered = createDeferred();
    const resume = createDeferred();
    const placement: PlacementContext = {
      workerSessionPlacementService: {
        getMany: () => new Map(),
        getManyAsync: async () => {
          entered.resolve();
          await resume.promise;
          return new Map();
        },
      },
    };
    const pending = (async () => {
      if (operation === "restore") {
        await restore(key, entry, placement);
        return { ok: true };
      }
      return archive(key, entry, placement);
    })();
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "placement preparation was skipped",
      );
      await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({
        lifecycleRevision: "replacement",
      }));
    } finally {
      resume.resolve();
      await settled;
    }
    expect(await settled).toMatchObject(
      operation === "restore"
        ? { error: expect.objectContaining({ message: expect.stringMatching(/Session changed/) }) }
        : { value: { ok: false } },
    );
    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
      sessionId: entry.sessionId,
      archivedAt: entry.archivedAt,
      lifecycleRevision: "replacement",
    });
  },
);
