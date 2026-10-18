import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  persistCompactionBoundaryWithSessionEntryAsync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import {
  createTestProjection,
  watchRowFacts,
} from "./session-row-projection.read-fixture.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

it("retains compaction display facts until a branch change requires a new tail", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey: "agent:main:compaction-display",
      sessionId: "compaction-display",
    };
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    const keptId = await manager.appendMessageAsync({
      role: "user",
      content: "Keep this request",
      timestamp: 1,
    });
    expect(keptId).toBeTypeOf("string");
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Keep this reply" }],
        timestamp: 2,
      }),
    );
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "Keep this reply",
      lastAssistantMessage: { text: "Keep this reply" },
    });
    const reads: string[] = [];
    watchRowFacts((owner) => (input) => {
      reads.push(...input.sessionKeys);
      return owner.readRowFacts(input);
    });
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");

    const compact = () =>
      withSessionCompactionPersistenceAsync(
        manager,
        (prepared) =>
          persistCompactionBoundaryWithSessionEntryAsync(scope, {
            prepared,
            tokensAfter: 45,
            transcriptByteCompactionLatch: null,
          }),
        () => manager.appendCompactionAsync("Earlier context summary", keptId!, 100),
      );
    await compact();
    await projection.ensureMaterialized();
    await nextTurn();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      totalTokens: 45,
      lastMessagePreview: "Keep this reply",
      lastAssistantMessage: { text: "Keep this reply" },
    });
    expect(projection.capture(query)?.entry?.compactionCount).toBe(1);
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "New reply" }], timestamp: 3 }),
    );
    await compact();
    await projection.ensureMaterialized();
    await nextTurn();
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "New reply",
      lastAssistantMessage: { text: "New reply" },
    });
    expect(reads).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();

    await manager.branchAsync(keptId!);
    const changedBranch = observeSessionRowBackfill([scope.sessionKey], projection, (row) =>
      row.lastMessagePreview === "Keep this request" && !row.lastAssistantMessage ? row.key : "",
    );
    await compact();
    await projection.ensureMaterialized();
    await withinTest(changedBranch, signal);
    expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
      "Keep this request",
    );
    expect(
      projection.snapshot(query, { includeLastMessage: true }).row?.lastAssistantMessage,
    ).toBeUndefined();
    expect(backfill).toHaveBeenCalled();
  });
});
