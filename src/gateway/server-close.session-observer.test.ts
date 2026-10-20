import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createTestGate, readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import * as sessionObserverModel from "./session-observer-model.js";

it("drains an accepted observer digest before closing its database", async ({ signal }) => {
  const gate = createTestGate(signal);
  const fixture = await createGatewayMetadataCloseFixture("gateway-session-observer-close");
  const persistEntered = createDeferred();
  const releasePersist = createDeferred();
  const disposalEntered = createDeferred();
  let handling: Promise<void> | undefined;
  let persisting: Promise<boolean | null> | undefined;
  let closing: Promise<void> | undefined;
  let removeClient: (() => void) | undefined;
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
    removeClient = () => void kernel.clients.delete(client);
    const subscription = context.subscribeSessionMessageEvents(client.connId, sessionKey, {
      provisional: true,
    });
    assert(subscription, "Observer subscription admitted for the active connection");
    subscription.commit();
    observer.setConnectionVisibility(client.connId, true);

    const persist = sessionObserverModel.defaultPersistDigest;
    let settledBeforeDatabaseClose = false;
    vi.spyOn(sessionObserverModel, "defaultPersistDigest").mockImplementation((params) => {
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
    await gate(persistEntered.promise, handling, "Observer skipped digest persistence");
    await withinTest(handling, signal);
    const dispose = observer.disposeAsync.bind(observer);
    vi.spyOn(observer, "disposeAsync").mockImplementation(() => {
      const pending = dispose();
      disposalEntered.resolve();
      return pending;
    });
    const closed = vi.fn<() => void>();
    closing = server.close({ reason: "session observer close regression" }).then(closed);
    await gate(disposalEntered.promise, closing, "Gateway closed without joining the observer");
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(agent.db.isOpen).toBe(true);
    await expect(
      observer.handleEventAsync({
        ...event,
        seq: 2,
        data: { kind: "preamble", progressText: "Refused after shutdown" },
      }),
    ).rejects.toThrow("Session observer is closed");

    releasePersist.resolve();
    const [accepted] = await withinTest(Promise.all([persisting, closing]), signal);
    expect(accepted).toBe(true);
    expect(settledBeforeDatabaseClose).toBe(true);
    expect(agent.db.isOpen).toBe(false);
    const [row] = readClosedDatabase(
      agent.path,
      "SELECT json_extract(entry_json, '$.observerDigest') AS digest FROM session_nodes WHERE session_key = ?",
      sessionKey,
    );
    expect(JSON.parse(String(row?.digest))).toMatchObject({ headline, runId, revision: 1 });
  } finally {
    releasePersist.resolve();
    await Promise.allSettled([handling, persisting, closing]);
    vi.restoreAllMocks();
    removeClient?.();
    await fixture.cleanup();
  }
});
