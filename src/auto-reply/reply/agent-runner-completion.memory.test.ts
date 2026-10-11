import { afterEach, expect, it, vi } from "vitest";
import type { SessionActorPendingFinalDelivery } from "../../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../../config/sessions/session-actor-storage-result.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory turn completion opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory turn completion allocated a worker");
  }),
}));

const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:incognito-completion",
  storePath: resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/turn-completion" },
  }),
};
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

afterEach(() => {
  replyRunRegistry.get(scope.sessionKey)?.complete();
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath });
});

it("settles unbound memory usage and final custody without losing an intervening actor edit", async () => {
  const entry: SessionEntry = {
    sessionId: "completion-session",
    lifecycleRevision: "completion-lifecycle",
    activeWriterRunId: "completion-run",
    updatedAt: 1,
    incognito: true,
    label: "Before completion",
    modelProvider: "fixture-provider",
    model: "before",
    groupActivationNeedsSystemIntro: true,
  };
  const initial = await acquireSessionActorStorage(scope, { lifetime, authority, create: true });
  if (!initial) {
    throw new Error("Expected initial memory actor");
  }
  try {
    readSessionActorStorageResult(
      await initial.actor.storage.mutate(
        { type: "session.entry.create", input: { entry } },
        authority,
      ),
    );
  } finally {
    await initial.actor.release();
  }
  const operation = createReplyOperation({
    ...scope,
    sessionId: entry.sessionId,
    resetTriggered: false,
  });
  operation.setPhase("running");
  const pendingFinal: SessionActorPendingFinalDelivery = {
    kind: "replayable",
    text: "Completed reply",
    createdAt: 100,
    intentId: "final-intent",
    deliveries: [{ id: "final-delivery", state: "prepared" }],
  };
  const published: SessionEntry[] = [];
  const result = await withAgentTurnCompletion(
    { ...scope, entry, operation, publish: (committed) => published.push(committed) },
    async (completion) => {
      if (!completion) {
        throw new Error("Unbound incognito turn omitted completion accounting");
      }
      completion.patch({
        kind: "usage",
        updatedAt: 100,
        update: {
          usage: { input: 120, output: 8, cacheRead: 10 },
          modelSelection: { provider: "fixture-provider", model: "before" },
          currentContextTokens: 400,
          estimatedCostUsd: 0.01,
          hasUsage: true,
          hasBilling: true,
          hasContextUpdate: true,
          hasFreshContextSnapshot: true,
          hasCurrentContextSnapshot: true,
          preserveSessionModelState: true,
          preserveUserFacingRunState: false,
        },
      });
      completion.patch((current) => ({
        kind: "group-intro",
        needsSystemIntro: current.label === "Before completion",
      }));
      const concurrent = await acquireSessionActorStorage(scope, { lifetime, authority });
      if (!concurrent) {
        throw new Error("Expected existing memory actor");
      }
      try {
        readSessionActorStorageResult(
          await concurrent.actor.storage.mutate(
            {
              type: "session.entry.patch",
              input: {
                operation: {
                  kind: "fields",
                  patch: { label: "Edited during completion", model: "after" },
                },
              },
            },
            authority,
          ),
        );
      } finally {
        await concurrent.actor.release();
      }
      expect(published).toEqual([]);
      return completion.complete(pendingFinal);
    },
  );
  const stored = memorySessionActorOwners
    .read({ agentId: scope.agentId, path: scope.storePath })
    ?.readSession(scope.sessionKey, authority)?.entry;
  expect(stored).toMatchObject({
    sessionId: entry.sessionId,
    activeWriterRunId: "completion-run",
    label: "Edited during completion",
    model: "after",
    inputTokens: 120,
    outputTokens: 8,
    cacheRead: 10,
    totalTokens: 400,
    totalTokensFresh: true,
    estimatedCostUsd: 0.01,
    groupActivationNeedsSystemIntro: false,
    pendingFinalDelivery: pendingFinal,
  });
  expect(result).toEqual(stored);
  expect(published).toEqual([stored]);
});
