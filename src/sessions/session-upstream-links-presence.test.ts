import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleSessionStateSessionDeleted } from "./session-state-events.js";
import { sessionUpstreamPresencePublication } from "./session-upstream-links-publication.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamPresence,
  settleSessionUpstreamLink,
} from "./session-upstream-links-runtime.js";
import {
  deleteSessionUpstreamLink,
  deleteSessionUpstreamLinkAsync,
  upsertSessionUpstreamLink,
  upsertSessionUpstreamLinkAsync,
} from "./session-upstream-links.js";
import { deleteSessionUpstreamLinkInDatabase } from "./session-upstream-links.kernel.js";

afterEach(() => vi.restoreAllMocks());

it.each(["worker delete", "settlement", "session cleanup", "legacy SDK"] as const)(
  "keeps prepared upstream presence current after %s without guard SQL",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      openOpenClawStateDatabase();
      const input = {
        sessionKey: "agent:main:presence",
        agentId: "main",
        catalogId: "fixture",
        hostId: "gateway:local",
        threadId: "presence-thread",
        upstreamKind: "codex-app-server" as const,
        upstreamRef: { threadId: "presence-thread" },
        marker: null,
      };
      using prepared = await prepareSessionUpstreamPresence(
        captureSessionUpstreamLinkReadSource(),
        input.sessionKey,
        input.agentId,
      );
      const expectPresence = (present: boolean) => {
        const sql = observeMainThreadSql();
        try {
          expect(prepared.current()).toBe(present);
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      };
      expectPresence(false);
      expect(
        await (writer === "legacy SDK"
          ? upsertSessionUpstreamLink(input, { now: 1 })
          : upsertSessionUpstreamLinkAsync(input, { now: 1 })),
      ).toBe(true);
      expectPresence(true);
      if (writer === "legacy SDK") {
        expect(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            deleteSessionUpstreamLinkInDatabase(db, input.sessionKey, input.agentId);
            throw new Error("rollback presence");
          }),
        ).toThrow("rollback presence");
        expectPresence(true);
        expect(deleteSessionUpstreamLink(input.sessionKey, input.agentId)).toBe("deleted");
      } else if (writer === "worker delete") {
        expect(await deleteSessionUpstreamLinkAsync(input.sessionKey, input.agentId)).toBe(
          "deleted",
        );
      } else if (writer === "settlement") {
        expect(
          await settleSessionUpstreamLink(
            { ...input, createdAt: 1, updatedAt: 1 },
            { kind: "missing" },
            { assertCurrent: () => {} },
          ),
        ).toBe(true);
      } else {
        await handleSessionStateSessionDeleted(input.sessionKey, input.agentId);
      }
      expectPresence(false);
    });
  },
);

it("keeps a committed adoption when the initial read reply arrives later", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    openOpenClawStateDatabase();
    const sessionKey = "agent:main:presence-late-read";
    const readComplete = createDeferredCore();
    const deliverRead = createDeferredCore();
    const read = stateReads.executeExistingOpenClawStateRead;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1].type === "sessionUpstream.read") {
        readComplete.resolve();
        await deliverRead.promise;
      }
      return result;
    });
    const pending = prepareSessionUpstreamPresence(
      captureSessionUpstreamLinkReadSource(),
      sessionKey,
      "main",
    );
    try {
      await awaitGateBeforeSettlement(readComplete.promise, pending, "upstream read preparation");
      expect(
        await upsertSessionUpstreamLinkAsync({
          sessionKey,
          agentId: "main",
          catalogId: "fixture",
          hostId: "gateway:local",
          threadId: "late-read-thread",
          upstreamKind: "codex-app-server",
          upstreamRef: null,
          marker: null,
        }),
      ).toBe(true);
    } finally {
      deliverRead.resolve();
    }
    using prepared = await pending;
    expect(prepared.link).toBeUndefined();
    expect(prepared.current()).toBe(true);
  });
});

it.each(["worker", "legacy SDK"] as const)(
  "observes %s adoption when the prepared source did not exist",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = captureSessionUpstreamLinkReadSource();
      expect(source.present).toBe(false);
      const sessionKey = "agent:main:presence-create";
      using prepared = await prepareSessionUpstreamPresence(source, sessionKey, "main");
      expect(prepared.current()).toBe(false);
      const input = {
        sessionKey,
        agentId: "main",
        catalogId: "fixture",
        hostId: "gateway:local",
        threadId: "created-thread",
        upstreamKind: "codex-app-server" as const,
        upstreamRef: null,
        marker: null,
      };
      expect(
        await (writer === "worker"
          ? upsertSessionUpstreamLinkAsync(input)
          : upsertSessionUpstreamLink(input)),
      ).toBe(true);
      const sql = observeMainThreadSql();
      try {
        expect(prepared.current()).toBe(true);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  },
);

it("denies the final guard when committed presence facts cannot be installed", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    openOpenClawStateDatabase();
    const sessionKey = "agent:main:presence-unknown";
    using prepared = await prepareSessionUpstreamPresence(
      captureSessionUpstreamLinkReadSource(),
      sessionKey,
      "main",
    );
    const release = sessionUpstreamPresencePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        throw new Error("presence publication unavailable");
      }
    });
    try {
      expect(
        await upsertSessionUpstreamLinkAsync({
          sessionKey,
          agentId: "main",
          catalogId: "fixture",
          hostId: "gateway:local",
          threadId: "unknown-thread",
          upstreamKind: "codex-app-server",
          upstreamRef: null,
          marker: null,
        }),
      ).toBe(true);
      expect(() => prepared.current()).toThrow("Session upstream source is unavailable");
    } finally {
      release();
    }
    using refreshed = await prepareSessionUpstreamPresence(
      captureSessionUpstreamLinkReadSource(),
      sessionKey,
      "main",
    );
    expect(refreshed.current()).toBe(true);
  });
});
