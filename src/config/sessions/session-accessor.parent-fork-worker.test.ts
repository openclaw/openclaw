import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { parseSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { forkSessionEntryFromParentTargetWithPatch } from "./session-accessor.sqlite-parent-session.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import * as storeTargetRuntime from "./session-store-target-runtime.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-parent-fork-worker-");

it.each(["none", "executor", "discovery"] as const)(
  "commits bundled fork and existing-child patches without caller-thread SQL (cleanupFailure=%s)",
  async (cleanupFailure) => {
    const storePath = path.join(sessionDirs.make(), "shared.sqlite");
    const agentId = "research";
    const parentKey = "agent:research:main";
    const childKey = "agent:research:typed-child";
    const parentScope = { agentId, sessionKey: parentKey, storePath };
    const childScope = { agentId, sessionKey: childKey, storePath };
    const parentTranscriptScope = { ...parentScope, sessionId: "typed-parent" };
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    expect(database.agentId).toBe("main");
    await replaceSessionEntry(parentScope, { sessionId: "typed-parent", updatedAt: 1 });
    await replaceTranscriptEvents(parentTranscriptScope, [
      { type: "session", version: 3, id: "typed-parent", timestamp: "2026-09-15T00:00:00Z" },
      {
        type: "message",
        id: "assistant",
        parentId: null,
        message: { role: "assistant", content: "parent context" },
      },
    ]);
    const parentEntry = loadSessionEntry(parentScope);
    const parentEvents = await loadTranscriptEvents(parentTranscriptScope);
    const params = {
      agentId,
      storePath,
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "", updatedAt: 1 },
    };
    const cleanupError = new Error(`synthetic fork ${cleanupFailure} cleanup failure`);
    let cleanupFailures = 0;
    const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
    const captureSpy =
      cleanupFailure === "executor"
        ? vi
            .spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution")
            .mockImplementation((...args): ReturnType<typeof capture> => {
              const owner = capture(...args);
              return {
                ...owner,
                get fileIdentity() {
                  return owner.fileIdentity;
                },
                async release() {
                  await owner.release();
                  cleanupFailures++;
                  throw cleanupError;
                },
              };
            })
        : undefined;
    const discover = storeTargetRuntime.withSessionStoreTarget;
    const discoverySpy =
      cleanupFailure === "discovery"
        ? vi
            .spyOn(storeTargetRuntime, "withSessionStoreTarget")
            .mockImplementation(async <T>(...args: Parameters<typeof discover<T>>): Promise<T> => {
              await discover(...args);
              cleanupFailures++;
              throw cleanupError;
            })
        : undefined;
    const sql = observeHostDataSql();
    let fork: Awaited<ReturnType<typeof forkSessionEntryFromParentTargetWithPatch>>;
    try {
      fork = await forkSessionEntryFromParentTargetWithPatch(params, {
        forked: { label: "forked child" },
      });
      expect(fork).toMatchObject({ status: "forked", sessionEntry: { label: "forked child" } });
      const skipped = await forkSessionEntryFromParentTargetWithPatch(params, {
        skipExisting: true,
        skipped: { label: "existing child" },
      });
      expect(skipped).toMatchObject({
        status: "skipped",
        reason: "existing-entry",
        sessionEntry: { label: "existing child" },
      });
      expect(sql.queries).toEqual([]);
    } finally {
      discoverySpy?.mockRestore();
      captureSpy?.mockRestore();
      sql.restore();
    }
    if (cleanupFailure !== "none") {
      expect(cleanupFailures).toBeGreaterThan(0);
    }
    if (fork.status !== "forked") {
      throw new Error("expected forked session");
    }
    expect(fork.fork.sessionFile).toBe(childKey);
    expect(fork.fork.sessionId).not.toBe("typed-parent");
    expect(fork.parentEntry).toEqual(parentEntry);
    expect(loadSessionEntry(childScope)).toMatchObject({
      sessionId: fork.fork.sessionId,
      label: "existing child",
      forkedFromParent: true,
      forkSource: { sessionKey: parentKey, sessionId: "typed-parent" },
    });
    const forkEvents = (await loadTranscriptEvents({
      ...childScope,
      sessionId: fork.fork.sessionId,
    })) as Record<string, unknown>[];
    const header = forkEvents[0];
    expect(header).toMatchObject({ type: "session", id: fork.fork.sessionId });
    expect(
      parseSqliteSessionFileMarker(
        typeof header?.parentSession === "string" ? header.parentSession : undefined,
      ),
    ).toEqual({ agentId, sessionId: "typed-parent", storePath });
    expect(forkEvents.slice(1)).toEqual(parentEvents.slice(1));
    expect(loadSessionEntry(parentScope)).toEqual(parentEntry);
    await expect(loadTranscriptEvents(parentTranscriptScope)).resolves.toEqual(parentEvents);
  },
);
