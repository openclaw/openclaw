// Install manager and runtime mocks before loading the reset implementation.
// oxfmt-ignore
import {
  acpRuntimeMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { writeSessionStore } from "./test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each(["already ineligible", "caller retired", "eligibility retired"] as const)(
  "ACP reset preserves its row and resume state when %s before metadata commit",
  async (reason) => {
    const acpEntryWriter = await import("../acp/runtime/session-meta-entry.js");
    const { closeAcpRuntimeForSession } = await import("./session-reset-acp.js");
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:main";
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
    writeAcpSessionMetaForMigration({
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
    const beforeMeta = readAcpSessionMeta({ sessionKey });
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
    let current = true;
    let eligible = reason !== "already ineligible";
    const onResetMeta = vi.fn();
    const resetting = closeAcpRuntimeForSession({
      cfg: { session: { store: storePath } },
      agentId: "main",
      sessionKey,
      reason: "session-reset",
      shouldCleanup: () => eligible,
      assertCurrent: () => {
        if (!current) {
          throw new Error("reset caller retired");
        }
      },
      onResetMeta,
    });
    const outcome = resetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      if (reason === "already ineligible") {
        await expect(outcome).resolves.toEqual({ ok: true, value: undefined });
        expect(intercepted).not.toHaveBeenCalled();
      } else {
        await Promise.race([
          reached.promise,
          outcome.then(() => {
            throw new Error("ACP reset settled before the metadata mutation boundary");
          }),
        ]);
        current = reason !== "caller retired";
        eligible = reason !== "eligibility retired";
        release.resolve();
        const settled = await outcome;
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(String(settled.error)).toMatch(/reset caller retired|superseded/);
        }
      }
      expect(onResetMeta).not.toHaveBeenCalled();
      expect(loadSessionEntry(scope)).toEqual(beforeEntry);
      expect(readAcpSessionMeta({ sessionKey })).toEqual(beforeMeta);
    } finally {
      release.resolve();
      await outcome;
      intercepted.mockRestore();
    }
  },
);
