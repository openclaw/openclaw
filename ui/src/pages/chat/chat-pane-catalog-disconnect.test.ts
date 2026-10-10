/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://catalog-pane-disconnect.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture, type TestChatPane } from "./chat-pane.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const key = { catalogId: "fixture", hostId: "gateway:local", threadId: "closed-pane" };
const listed: SessionsCatalogListResult = {
  catalogs: [
    {
      id: key.catalogId,
      label: "Fixture catalog",
      capabilities: { continueSession: false, archive: false },
      hosts: [
        {
          hostId: key.hostId,
          label: "Local fixture",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: key.threadId,
              name: "Closed pane fixture",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ],
    },
  ],
};
const readResult: SessionsCatalogReadResult = {
  hostId: key.hostId,
  threadId: key.threadId,
  items: [{ id: "late-item", type: "agentMessage", text: "Late closed-pane transcript" }],
};

beforeEach(installTranscriptDomMocks);
afterEach(async () => {
  resetTranscriptTestDom();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
});

function mountCatalogPane(request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>) {
  const client = createGatewayBrowserClientFixture();
  vi.spyOn(client, "request").mockImplementation(request);
  const fixture = createRefreshChatPane(client);
  fixture.context.config.subscribe = () => () => {};
  const pane = fixture.pane as unknown as TestChatPane;
  pane.sessionKey = buildCatalogSessionKey(key, "main");
  const loads = vi.spyOn(pane, "loadCatalogSession");
  // The render fixture keeps the real DOM connection and teardown callbacks.
  document.body.append(pane);
  return { pane, client, context: fixture.context, loads };
}

function pendingLoads(loads: ReturnType<typeof mountCatalogPane>["loads"]) {
  return loads.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
}

describe("catalog pane disconnect ownership", () => {
  it.each(["before", "after"] as const)(
    "does not start a transcript read when the pane disconnects %s lookup settles",
    async (disconnectTiming) => {
      const lookup = createDeferred<SessionsCatalogListResult>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.catalog.list") {
          return lookup.promise;
        }
        if (method === "sessions.catalog.read") {
          return Promise.resolve(readResult);
        }
        return Promise.resolve({});
      });
      const { pane, client, context, loads } = mountCatalogPane(request);
      try {
        await vi.waitFor(() =>
          expect(request.mock.calls.some(([method]) => method === "sessions.catalog.list")).toBe(
            true,
          ),
        );
        const active = pendingLoads(loads);
        expect(active.length).toBeGreaterThan(0);
        expect(pane.isConnected).toBe(true);
        const messagesBeforeClose = pane.catalogMessages;
        const sessionBeforeClose = pane.catalogSession;
        if (disconnectTiming === "before") {
          pane.remove();
          lookup.resolve(listed);
        } else {
          lookup.resolve(listed);
          // Retire the pane after the lookup helper resumes but before its caller does.
          queueMicrotask(() => pane.remove());
        }
        await Promise.all(active);

        expect(pane.isConnected).toBe(false);
        expect(pane.state).toBeUndefined();
        expect(context.gateway.snapshot.client).toBe(client);
        expect(context.gateway.snapshot.phase).toBe("connected");
        expect
          .soft(request.mock.calls.filter(([method]) => method === "sessions.catalog.read"))
          .toHaveLength(0);
        expect.soft(pane.catalogMessages).toEqual(messagesBeforeClose);
        expect.soft(pane.catalogSession).toEqual(sessionBeforeClose);
      } finally {
        pane.remove();
        lookup.resolve(listed);
        await Promise.allSettled(pendingLoads(loads));
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "does not publish when an outstanding transcript read %ss after disconnect",
    async (settlement) => {
      const read = createDeferred<SessionsCatalogReadResult>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.catalog.list") {
          return listed;
        }
        if (method === "sessions.catalog.read") {
          return await read.promise;
        }
        return {};
      });
      const { pane, client, context, loads } = mountCatalogPane(request);
      try {
        await vi.waitFor(() =>
          expect(request.mock.calls.some(([method]) => method === "sessions.catalog.read")).toBe(
            true,
          ),
        );
        const active = pendingLoads(loads);
        const readCount = request.mock.calls.filter(
          ([method]) => method === "sessions.catalog.read",
        ).length;
        const state = pane.state;
        pane.remove();
        expect(pane.isConnected).toBe(false);
        expect(pane.state).toBeUndefined();
        expect(context.gateway.snapshot.client).toBe(client);
        expect(context.gateway.snapshot.phase).toBe("connected");
        const messagesAfterClose = pane.catalogMessages;
        const errorAfterClose = state.lastError;

        if (settlement === "resolve") {
          read.resolve(readResult);
        } else {
          read.reject(new Error("Late closed-pane failure"));
        }
        await Promise.all(active);

        expect
          .soft(request.mock.calls.filter(([method]) => method === "sessions.catalog.read"))
          .toHaveLength(readCount);
        expect.soft(pane.catalogMessages).toEqual(messagesAfterClose);
        expect.soft(state.lastError).toBe(errorAfterClose);
      } finally {
        pane.remove();
        read.resolve(readResult);
        await Promise.allSettled(pendingLoads(loads));
      }
    },
  );
});
