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

const sessionKey = "agent:main:presence";
function link() {
  return {
    sessionKey,
    agentId: "main",
    catalogId: "fixture",
    hostId: "gateway:local",
    threadId: "presence-thread",
    upstreamKind: "codex-app-server" as const,
    upstreamRef: null,
    marker: null,
  };
}

function presence(source = captureSessionUpstreamLinkReadSource()) {
  return prepareSessionUpstreamPresence(source, sessionKey, "main");
}

function expectPresence(prepared: { current(): boolean }, present: boolean) {
  const sql = observeMainThreadSql();
  try {
    expect(prepared.current()).toBe(present);
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

it.each([
  ["worker delete", true],
  ["settlement", true],
  ["session cleanup", true],
  ["legacy SDK", true],
  ["worker", false],
  ["legacy SDK", false],
] as const)(
  "keeps presence current through %s (existing source: %s) without guard SQL",
  async (writer, existing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      if (existing) {
        openOpenClawStateDatabase();
      }
      const source = captureSessionUpstreamLinkReadSource();
      expect(source.present).toBe(existing);
      const input = {
        ...link(),
        upstreamRef: existing ? { threadId: "presence-thread" } : null,
      };
      using prepared = await presence(source);
      expectPresence(prepared, false);
      const upsert =
        writer === "legacy SDK" ? upsertSessionUpstreamLink : upsertSessionUpstreamLinkAsync;
      expect(await upsert(input, existing ? { now: 1 } : undefined)).toBe(true);
      expectPresence(prepared, true);
      if (!existing) {
        return;
      }
      if (writer === "legacy SDK") {
        expect(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            deleteSessionUpstreamLinkInDatabase(db, sessionKey, "main");
            throw new Error("rollback presence");
          }),
        ).toThrow("rollback presence");
        expectPresence(prepared, true);
        expect(deleteSessionUpstreamLink(sessionKey, "main")).toBe("deleted");
      } else if (writer === "worker delete") {
        expect(await deleteSessionUpstreamLinkAsync(sessionKey, "main")).toBe("deleted");
      } else if (writer === "settlement") {
        const settled = await settleSessionUpstreamLink(
          { ...input, createdAt: 1, updatedAt: 1 },
          { kind: "missing" },
          { assertCurrent: () => {} },
        );
        expect(settled).toBe(true);
      } else {
        await handleSessionStateSessionDeleted(sessionKey, "main");
      }
      expectPresence(prepared, false);
    });
  },
);

it("keeps a committed adoption when the initial read reply arrives later", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    openOpenClawStateDatabase();
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
    const pending = presence();
    try {
      await awaitGateBeforeSettlement(readComplete.promise, pending, "upstream read preparation");
      expect(await upsertSessionUpstreamLinkAsync(link())).toBe(true);
    } finally {
      deliverRead.resolve();
    }
    using prepared = await pending;
    expect(prepared.link).toBeUndefined();
    expect(prepared.current()).toBe(true);
  });
});

it("denies the final guard when committed presence facts cannot be installed", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    openOpenClawStateDatabase();
    using prepared = await presence();
    const release = sessionUpstreamPresencePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        throw new Error("presence publication unavailable");
      }
    });
    try {
      expect(await upsertSessionUpstreamLinkAsync(link())).toBe(true);
      expect(() => prepared.current()).toThrow("Session upstream source is unavailable");
    } finally {
      release();
    }
    using refreshed = await presence();
    expect(refreshed.current()).toBe(true);
  });
});
