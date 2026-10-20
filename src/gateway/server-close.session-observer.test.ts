import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import * as sessionObserverModel from "./session-observer-model.js";

it("settles an accepted observer digest across the close prelude before closing its database", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-session-observer-close");
  const persistEntered = createDeferred();
  const releasePersist = createDeferred();
  const disposalEntered = createDeferred();
  let handling: Promise<void> | undefined;
  let persisting: Promise<boolean | null> | undefined;
  let closing: Promise<void> | undefined;
  let removeClient: (() => void) | undefined;
  let restorePersist: (() => void) | undefined;
  let restoreDispose: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await withinTest(fixture.start(port), signal);
    const kernel = fixture.kernels.get(port);
    assert(kernel, "Gateway kernel");
    const context = kernel.resolvePluginGatewayContext();
    assert(context, "Gateway context");
    const observer = context.sessionObserver;
    assert(observer, "Session observer");
    const sessionKey = "agent:main:observer-close";
    const sessionId = "observer-close-session";
    const runId = "observer-close-run";
    const headline = "Accepted before shutdown";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, lifecycleRevision: "observer-close-generation", updatedAt: 1 },
    );
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const { client } = makeClient("observer-close-client", "operator", ["operator.read"]);
    kernel.clients.add(client);
    removeClient = () => {
      kernel.clients.delete(client);
    };
    const subscription = context.subscribeSessionMessageEvents(client.connId, sessionKey, {
      provisional: true,
    });
    assert(subscription, "Observer subscription admitted for the active connection");
    subscription.commit();
    observer.setConnectionVisibility(client.connId, true);

    const persist = sessionObserverModel.defaultPersistDigest;
    let settledBeforeDatabaseClose = false;
    const persistSpy = vi
      .spyOn(sessionObserverModel, "defaultPersistDigest")
      .mockImplementation((params) => {
        if (params.sessionKey !== sessionKey) {
          return persist(params);
        }
        persisting = (async () => {
          persistEntered.resolve();
          await releasePersist.promise;
          const result = await persist(params);
          settledBeforeDatabaseClose = agent.db.isOpen;
          return result;
        })();
        return persisting;
      });
    restorePersist = () => persistSpy.mockRestore();
    const event = {
      runId,
      sessionId,
      sessionKey,
      agentId: "main",
      seq: 1,
      ts: 1_000,
      stream: "item",
      data: { kind: "preamble", progressText: headline },
    };
    handling = observer.handleEventAsync(event);
    await withinTest(
      awaitGateBeforeSettlement(
        persistEntered.promise,
        handling,
        "Observer event settled without accepting its digest write",
      ),
      signal,
    );
    await withinTest(handling, signal);
    const dispose = observer.disposeAsync.bind(observer);
    const disposeSpy = vi.spyOn(observer, "disposeAsync").mockImplementation(() => {
      const pending = dispose();
      disposalEntered.resolve();
      return pending;
    });
    restoreDispose = () => disposeSpy.mockRestore();
    let closed = false;
    closing = server.close({ reason: "session observer close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        disposalEntered.promise,
        closing,
        "Gateway closed without joining the observer",
      ),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(agent.db.isOpen).toBe(true);
    await expect(
      observer.handleEventAsync({
        ...event,
        seq: 2,
        data: {
          kind: "preamble",
          progressText: "Refused after shutdown",
        },
      }),
    ).rejects.toThrow("Session observer is closed");

    releasePersist.resolve();
    const [accepted] = await withinTest(Promise.all([persisting, closing]), signal);
    expect(accepted).toBe(true);
    expect(settledBeforeDatabaseClose).toBe(true);
    expect(agent.db.isOpen).toBe(false);
    const reopened = new DatabaseSync(agent.path, { readOnly: true });
    try {
      expect(
        reopened
          .prepare(`
        SELECT json_extract(entry_json, '$.observerDigest.headline') AS headline,
               json_extract(entry_json, '$.observerDigest.runId') AS run_id,
               json_extract(entry_json, '$.observerDigest.revision') AS revision
        FROM session_nodes WHERE session_key = ?
      `)
          .get(sessionKey),
      ).toEqual({ headline, run_id: runId, revision: 1 });
    } finally {
      reopened.close();
    }
  } finally {
    releasePersist.resolve();
    await Promise.allSettled([handling, persisting, closing]);
    restoreDispose?.();
    restorePersist?.();
    removeClient?.();
    await fixture.cleanup();
  }
});
