import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { PluginHookRunStoppedEvent } from "../plugins/hook-run-stopped.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import type { SessionControllerInput } from "./session-controller.contracts.js";
import {
  captureAbortTargetMark,
  notifySessionRunStopped,
  trackUserStop,
  type AbortTargetMark,
} from "./session-run-stopped.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);
afterEach(() => {
  resetGlobalHookRunner();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

describe("notifySessionRunStopped", () => {
  it("starts run_stopped handlers before returning and never fails the Stop", async () => {
    const seen: PluginHookRunStoppedEvent[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "run_stopped",
          pluginId: "observer",
          handler: async (event) => {
            seen.push(event as PluginHookRunStoppedEvent);
            await slow;
          },
        },
        {
          hookName: "run_stopped",
          pluginId: "broken",
          handler: () => {
            throw new Error("handler failed");
          },
        },
      ]),
    );

    expect(() =>
      notifySessionRunStopped({
        source: "channel-user",
        sessions: [
          { agentId: "main", sessionKey: "agent:main:a" },
          {
            agentId: "main",
            sessionKey: "agent:main:a",
            storePath: "/stores/s.json",
            sessionId: "s1",
          },
          { sessionKey: "agent:main:no-agent" },
        ],
        runIds: [" run-1 ", "run-1", "", "run-2"],
      }),
    ).not.toThrow();

    // Synchronous start lets consumers act before the stopped run's own completion arrives, and
    // plugins never see the session's store or incarnation.
    expect(seen).toEqual([
      {
        source: "channel",
        sessions: [{ agentId: "main", sessionKey: "agent:main:a" }],
        runIds: ["run-1", "run-2"],
      },
    ]);
    release();
  });

  it("returns the accepted Stop's receipt even when no plugin listens", () => {
    const before = Date.now();
    const receipt = notifySessionRunStopped({
      source: "client-session",
      sessions: [
        {
          agentId: "main",
          sessionKey: "agent:main:a",
          storePath: "/stores/s.json",
          sessionId: "s1",
        },
        { sessionKey: "agent:main:b" },
      ],
      runIds: ["run-1"],
    });
    // The receipt keeps the store and incarnation the Stop was authorized against.
    expect(receipt.sessions).toEqual([
      { agentId: "main", sessionKey: "agent:main:a", storePath: "/stores/s.json", sessionId: "s1" },
    ]);
    expect(receipt.stoppedAt).toBeGreaterThanOrEqual(before);
  });
});

/** A cancelled source input of run-1 on incarnation s1 of one stored row. */
const inputOf = (sessionKey: string, storeScope: string) =>
  ({
    instance: { id: `${storeScope}:${sessionKey}` },
    protocolRunId: "run-1",
    sourceSessionId: "s1",
    target: { storeScope },
    mailbox: { key: sessionKey },
  }) as unknown as SessionControllerInput;

describe("trackUserStop records", () => {
  it("records only on the incarnation whose owning run the Stop ended", async () => {
    // The receipt carries the store its Stop was authorized against, not the agent's default.
    const storePath = path.join(tempDirs.make("openclaw-run-stopped-"), "sessions.json");
    const key = (id: string) => `agent:main:${id}`;
    const stop = (at: number, sessionId: string) => ({
      userStoppedAt: at,
      userStoppedSessionId: sessionId,
    });
    for (const [id, row] of Object.entries({
      owned: { activeWriterRunId: "run-1" },
      newer: { activeWriterRunId: "run-1", ...stop(9_000, "s1") },
      carried: { activeWriterRunId: "run-1", ...stop(9_000, "s0") },
      replaced: { sessionId: "s2", activeWriterRunId: "run-1" },
      // A successor's writer outranks the stopped run's lastRunId; once terminal, lastRunId owns.
      successor: { activeWriterRunId: "run-2", lastRunId: "run-1" },
      terminal: { lastRunId: "run-1" },
      idle: { lastRunId: "run-0" },
      idleUnmarked: { lastRunId: "run-0" },
      // A mark proves only the row it was written on.
      idleOther: { lastRunId: "run-0" },
      // A successor admitted after the idle mark no longer matches the target it was guarded on.
      idleSuccessor: { activeWriterRunId: "run-9", lastRunId: "run-0" },
      // The same incarnation id and run id on another row was not cancelled there.
      elsewhere: { activeWriterRunId: "run-1" },
    })) {
      await replaceSessionEntry(
        { storePath, sessionKey: key(id) },
        { sessionId: "s1", updatedAt: 1, ...row },
      );
    }
    // The same key, incarnation and owner in another store: a copied row, or `global`.
    const otherStore = path.join(tempDirs.make("openclaw-run-stopped-"), "sessions.json");
    for (const [id, row] of Object.entries({
      owned: { activeWriterRunId: "run-1" },
      idle: { lastRunId: "run-0" },
    })) {
      await replaceSessionEntry(
        { storePath: otherStore, sessionKey: key(id) },
        { sessionId: "s1", updatedAt: 1, ...row },
      );
    }
    // A user's Stop whose committed cancellations (or idle abort mark) prove each row its own.
    const record = async (
      ids: string[],
      cancelled: string[],
      mark?: AbortTargetMark,
      store = storePath,
    ) => {
      const userStop = trackUserStop({
        reason: createAgentRunDirectAbortError(true),
        receipt: () => ({
          stoppedAt: 5_000,
          sessions: ids.map((id) => ({
            agentId: "main",
            sessionKey: key(id),
            storePath: store,
            sessionId: "s1",
          })),
        }),
      });
      for (const id of cancelled) {
        userStop.cancelled(inputOf(key(id), storePath));
      }
      await userStop.record(mark);
    };
    const markOn = (id: string) =>
      captureAbortTargetMark({ storePath, sessionKey: key(id) }, { sessionId: "s1" });
    const owned = ["owned", "newer", "carried", "replaced", "successor", "terminal", "missing"];
    await record(owned, owned);
    await record(["elsewhere"], ["owned"]);
    await record(["owned"], ["owned"], undefined, otherStore);
    // An idle Stop cancels nothing; only the native abort mark proves the row its own.
    await record(["idle", "idleOther"], [], markOn("idle"));
    await record(["idle"], [], markOn("idle"), otherStore);
    await record(["idleSuccessor"], [], markOn("idleSuccessor"));
    await record(["idleUnmarked"], []);
    const stored = (id: string) => loadSessionEntry({ storePath, sessionKey: key(id) });
    for (const id of ["owned", "carried", "terminal", "idle"]) {
      expect(stored(id), id).toMatchObject(stop(5_000, "s1"));
    }
    expect(stored("newer")).toMatchObject(stop(9_000, "s1"));
    for (const id of [
      "replaced",
      "successor",
      "idleUnmarked",
      "idleOther",
      "idleSuccessor",
      "elsewhere",
    ]) {
      expect(stored(id)?.userStoppedAt, id).toBeUndefined();
    }
    expect(stored("missing")).toBeUndefined();
    for (const id of ["owned", "idle"]) {
      const copy = loadSessionEntry({ storePath: otherStore, sessionKey: key(id) });
      expect(copy?.userStoppedAt, `${id} in the other store`).toBeUndefined();
    }
  });

  it("never fails the Stop when a record cannot be written", async () => {
    const userStop = trackUserStop({
      reason: createAgentRunDirectAbortError(true),
      receipt: () => ({
        stoppedAt: 1,
        // A store under a file cannot be opened, so the write throws.
        sessions: [
          { agentId: "main", sessionKey: "agent:main:a", storePath: "/dev/null/sessions.json" },
        ],
      }),
    });
    await expect(
      userStop.record(captureAbortTargetMark({ sessionKey: "agent:main:a" }, { sessionId: "s1" })),
    ).resolves.toBeUndefined();
  });
});

describe("trackUserStop", () => {
  it("records once, only for a user-initiated Stop that committed a cancellation", async () => {
    const storePath = path.join(tempDirs.make("openclaw-run-stopped-"), "sessions.json");
    const sessionKey = "agent:main:a";
    await replaceSessionEntry(
      { storePath, sessionKey },
      { sessionId: "s1", updatedAt: 1, activeWriterRunId: "run-1" },
    );
    const receipt = () => ({
      stoppedAt: 5_000,
      sessions: [{ agentId: "main", sessionKey, storePath, sessionId: "s1" }],
    });
    const input = inputOf(sessionKey, storePath);
    const stored = () => loadSessionEntry({ storePath, sessionKey })?.userStoppedAt;

    // Neither a non-user cancellation nor a user Stop that cancelled nothing records.
    const automated = trackUserStop({ reason: createAgentRunDirectAbortError(), receipt });
    automated.cancelled(input);
    await automated.record();
    await trackUserStop({ reason: createAgentRunDirectAbortError(true), receipt }).record();
    expect(stored()).toBeUndefined();

    const user = trackUserStop({ reason: createAgentRunDirectAbortError(true), receipt });
    user.cancelled(input);
    const attempt = user.record();
    const mark = captureAbortTargetMark({ storePath, sessionKey }, { sessionId: "s1" });
    expect(user.record(mark)).toBe(attempt);
    await attempt;
    expect(stored()).toBe(5_000);
  });
});
