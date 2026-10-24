import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { withoutPayloadReads } from "./session-accessor.observation.test-support.js";
import {
  readRecentSessionTranscriptActiveEvents,
  waitForSessionTranscriptProjection,
} from "./session-accessor.sqlite-active-events.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

const transactionInjection = vi.hoisted(() => ({ run: null as (() => void) | null }));

vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  const withDelivery = (
    owner: ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution>,
  ): typeof owner => {
    return {
      ...owner,
      get fileIdentity() {
        return owner.fileIdentity;
      },
      runExisting: (source, operation, options) =>
        owner.runExisting(
          source,
          (worker) =>
            operation({
              execute: (command, commandOptions) => {
                if (
                  command.type === "session.lifecycle.reset" ||
                  command.type === "session.lifecycle.project"
                ) {
                  // The snapshot is prepared, but the worker has not begun its transaction.
                  const inject = transactionInjection.run;
                  transactionInjection.run = null;
                  inject?.();
                }
                return worker.execute(command, commandOptions);
              },
            }),
          options,
        ),
    };
  };
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ) => withDelivery(actual.captureOpenClawAgentDatabaseExecution(...args)),
    captureOpenClawAgentDatabasePreparationExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabasePreparationExecution>
    ) => withDelivery(actual.captureOpenClawAgentDatabasePreparationExecution(...args)),
  };
});

const fixture = useTempSessionsFixture("openclaw-reset-boundary-race-");
let storePath: string;

beforeEach(() => {
  storePath = fixture.storePath();
});

afterEach(() => {
  transactionInjection.run = null;
});

it("does not commit a reset after its caller closes during entry preparation", async () => {
  const sessionKey = "agent:main:closing-reset";
  const scope = { sessionKey, storePath };
  await upsertSessionEntryCore(scope, { sessionId: "current-reset", updatedAt: 10 });
  let current = true;
  const commitGuard = () => {
    if (!current) {
      throw new Error("reset caller closed");
    }
  };
  await expect(
    resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      commitGuard,
      buildNextEntry: () => {
        commitGuard();
        queueMicrotask(() => {
          current = false;
        });
        return { sessionId: "stale-reset", updatedAt: 20 };
      },
    }),
  ).rejects.toThrow("reset caller closed");
  expect(loadSessionEntry(scope)?.sessionId).toBe("current-reset");
});

it.each(["single reset", "bulk lifecycle reset"])(
  "parents the %s boundary without hydrating caller message bodies",
  async (kind) => {
    const scope = {
      sessionId: "current-session",
      sessionKey: "agent:main:reset-race",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const body = "retained reset message body ".repeat(8_192);
    appendTranscriptMessageSync(scope, {
      eventId: "initial",
      message: { role: "user", content: body },
      parentId: null,
    });
    const entry = { sessionId: "next-session", updatedAt: 20 };
    const resetBoundary = {
      context: "preserve-tail",
      reason: "reset",
      cwd: "/tmp/workspace",
    } as const;
    transactionInjection.run = () => {
      appendTranscriptMessageSync(scope, {
        eventId: "concurrent",
        message: { role: "user", content: "accepted concurrently" },
        parentId: "initial",
      });
    };

    await withoutPayloadReads("event_json", body, async () => {
      if (kind === "single reset") {
        await resetSessionEntryLifecycle({
          buildNextEntry: () => entry,
          resetBoundary,
          storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        });
      } else {
        await applySessionEntryLifecycleMutation({
          skipMaintenance: true,
          storePath,
          upserts: [{ entry, resetBoundary, sessionKey: scope.sessionKey }],
        });
      }
    });

    const raw = await loadTranscriptEvents(scope);
    expect(raw).toContainEqual(
      expect.objectContaining({
        id: "initial",
        message: expect.objectContaining({ role: "user", content: body }),
      }),
    );
    const boundary = raw.find((event) => isRecord(event) && event.type === "reset");
    expect(boundary).toMatchObject({ parentId: "concurrent" });
    const expectConcurrent = async () => {
      await waitForSessionTranscriptProjection(scope);
      expect(
        readRecentSessionTranscriptActiveEvents(scope, 10).map(
          (event) => (event as { id?: unknown }).id,
        ),
      ).toContain("concurrent");
    };
    await expectConcurrent();

    await agentDatabase.closeOpenClawAgentDatabasesAsync();
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    await expectConcurrent();
  },
);

it("preserves navigation nulls and raw parser semantics in reset reads", async () => {
  const sessionId = "reset-projection";
  await upsertSessionEntryCore(
    { sessionKey: "agent:main:reset-projection", storePath },
    { sessionId, updatedAt: 10 },
  );
  const database = agentDatabase.openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
  });
  const navigationEvents = [
    { type: "message", id: "user", timestamp: 1, message: { role: "user", content: "body" } },
    { type: "leaf", id: "empty", parentId: null, targetId: null },
    {
      type: "leaf",
      id: "selected",
      parentId: "empty",
      targetId: "user",
      appendParentId: null,
      appendMode: "side",
    },
    { type: "reset", id: "reset", parentId: "user", firstKeptEntryId: "user" },
  ] as const;
  const events = [
    ...navigationEvents,
    null,
    "opaque",
    ["opaque"],
    JSON.parse(`{"type":"opaque","body":${"[".repeat(1_001)}0${"]".repeat(1_001)}}`) as unknown,
  ];
  const insert = createTranscriptEventInserter(database.db, sessionId);
  events.forEach((event, seq) => insert({ seq, eventJson: JSON.stringify(event), createdAt: seq }));

  const read = (options?: Parameters<typeof loadTranscriptEventsFromDatabase>[2]) =>
    loadTranscriptEventsFromDatabase(database, sessionId, options);
  const projected = read({
    projection: "reset-boundary",
  });
  expect(projected[0]).toEqual({ ...navigationEvents[0], message: { role: "user" } });
  expect(projected.slice(1, 4)).toMatchObject(navigationEvents.slice(1));
  expect(projected[1]).not.toHaveProperty("appendParentId");
  expect(projected.slice(4)).toEqual(events.slice(4));
  expect(read()).toEqual(events);
  expect(read({ beforeEventSeq: 2 })).toEqual(events.slice(0, 2));

  insert({ seq: events.length, eventJson: "{", createdAt: events.length });
  for (const projection of [undefined, "reset-boundary"] as const) {
    expect(() => read({ projection })).toThrow(SyntaxError);
  }
});
