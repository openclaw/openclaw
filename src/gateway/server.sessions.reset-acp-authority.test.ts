import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
// Install manager and runtime mocks before loading the reset implementation.
// oxfmt-ignore
import {
  acpManagerMocks,
  acpRuntimeMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { writeSessionStore } from "./test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each(["already retired", "caller retired"] as const)(
  "ACP reset preserves its row and resume state when %s before metadata commit",
  async (reason) => {
    const acpEntryWriter = await import("../acp/runtime/session-meta-entry.js");
    const { closeAcpRuntimeForSession } = await import("./session-reset-acp.js");
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:main";
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
    seedCanonicalAcpSessionMeta({
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:reset",
        identity: {
          state: "resolved",
          acpxRecordId: sessionKey,
          acpxSessionId: "original-backend",
          source: "status",
          lastUpdatedAt: Date.now(),
        },
        mode: "persistent",
        cwd: "/tmp/acp-session",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime: { prepareFreshSession: vi.fn(async () => {}) },
    });
    const scope = { agentId: "main", sessionKey, storePath };
    const beforeEntry = structuredClone(loadSessionEntry(scope));
    const beforeMeta = readAcpSessionEntry({ sessionKey })?.acp;
    const reached = createDeferred();
    const release = createDeferred();
    const originalWrite = acpEntryWriter.updateAcpSessionStoreEntry;
    const intercepted = vi
      .spyOn(acpEntryWriter, "updateAcpSessionStoreEntry")
      .mockImplementation(async (input) => {
        if (input.mutation.kind === "touch") {
          reached.resolve();
          await release.promise;
        }
        return await originalWrite(input);
      });
    let current = reason !== "already retired";
    const resetting = closeAcpRuntimeForSession({
      cfg: { session: { store: storePath } },
      agentId: "main",
      sessionKey,
      reason: "session-reset",
      assertCurrent: () => {
        if (!current) {
          throw new Error("reset caller retired");
        }
      },
    });
    const outcome = resetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      if (reason === "already retired") {
        await expect(outcome).resolves.toMatchObject({ ok: false });
        expect(intercepted).not.toHaveBeenCalled();
      } else {
        await Promise.race([
          reached.promise,
          outcome.then(() => {
            throw new Error("ACP reset settled before the metadata mutation boundary");
          }),
        ]);
        current = false;
        release.resolve();
        const settled = await outcome;
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(String(settled.error)).toContain("reset caller retired");
        }
      }
      expect(loadSessionEntry(scope)).toEqual(beforeEntry);
      expect(readAcpSessionEntry({ sessionKey })?.acp).toEqual(beforeMeta);
    } finally {
      release.resolve();
      await outcome;
      intercepted.mockRestore();
    }
  },
);

test("session delete removes local ACP metadata when owner repair blocks backend cleanup", async () => {
  const { closeAcpRuntimeForSession } = await import("./session-reset-acp.js");
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:main";
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  const meta = {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "legacy-unqualified",
    identity: {
      state: "resolved" as const,
      acpxRecordId: sessionKey,
      acpxSessionId: "original-backend",
      source: "ensure" as const,
      lastUpdatedAt: Date.now(),
    },
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
  seedCanonicalAcpSessionMeta({ sessionKey, meta });
  const repairError = new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "owner repair required", {
    detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
  });
  acpManagerMocks.cancelSession.mockRejectedValue(repairError);
  const cfg = { session: { store: storePath } };
  const before = readAcpSessionEntry({ sessionKey })?.acp;

  const reset = await closeAcpRuntimeForSession({
    cfg,
    agentId: "main",
    sessionKey,
    reason: "session-reset",
  });
  expect(reset).toMatchObject({ message: expect.stringContaining("owner repair required") });
  expect(readAcpSessionEntry({ sessionKey })?.acp).toEqual(before);

  const deleted = await closeAcpRuntimeForSession({
    cfg,
    agentId: "main",
    sessionKey,
    reason: "session-delete",
  });
  expect(deleted).toBeUndefined();
  expect(readAcpSessionEntry({ sessionKey })?.acp).toBeUndefined();
});
