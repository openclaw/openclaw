import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { createAcpMeta } from "../acp/runtime/session-meta-lifecycle.test-support.js";
// Install manager and runtime mocks before loading the reset implementation.
// oxfmt-ignore
import {
  acpRuntimeMocks,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";

const { seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.each(["already retired", "caller retired"] as const)(
  "ACP reset preserves its row and resume state when %s before metadata commit",
  async (reason) => {
    const acpEntryWriter = await import("../acp/runtime/session-meta-entry.js");
    const { closeAcpRuntimeForSession } = await import("./session-reset-acp.js");
    const { storePath } = await seedActiveMainSession();
    const sessionKey = "agent:main:main";
    seedCanonicalAcpSessionMeta({
      sessionKey,
      meta: createAcpMeta({
        backend: "acpx",
        agent: "codex",
        identity: {
          state: "resolved",
          acpxRecordId: sessionKey,
          acpxSessionId: "original-backend",
          source: "status",
          lastUpdatedAt: Date.now(),
        },
        cwd: "/tmp/acp-session",
      }),
    });
    acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime: { prepareFreshSession: vi.fn(async () => {}) },
    });
    const scope = { agentId: "main", sessionKey, storePath };
    const readState = () => ({
      entry: loadSessionEntry(scope),
      meta: readAcpSessionEntry({ sessionKey })?.acp,
    });
    const before = structuredClone(readState());
    const mutation = createRequestGate();
    const originalWrite = acpEntryWriter.updateAcpSessionStoreEntry;
    using intercepted = vi
      .spyOn(acpEntryWriter, "updateAcpSessionStoreEntry")
      .mockImplementation(async (input) => {
        if (input.mutation.kind === "touch") {
          await mutation.pause();
        }
        return await originalWrite(input);
      });
    let current = reason !== "already retired";
    const resetting = closeAcpRuntimeForSession({
      cfg: { session: { store: storePath } },
      agentId: "main",
      sessionKey,
      reason: "session-reset",
      assertCurrent: () => assert(current, "reset caller retired"),
    });
    const outcome = expect(resetting).rejects.toThrow("reset caller retired");
    try {
      if (reason === "already retired") {
        await outcome;
        expect(intercepted).not.toHaveBeenCalled();
      } else {
        await Promise.race([
          mutation.entered,
          outcome.then(() => {
            throw new Error("ACP reset settled before the metadata mutation boundary");
          }),
        ]);
        current = false;
        mutation.release();
        await outcome;
      }
      expect(readState()).toEqual(before);
    } finally {
      mutation.release();
      await outcome;
    }
  },
);
