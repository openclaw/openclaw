/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://catalog-pane-disconnect.test/"} */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { requestCalls } from "./chat-host.test-support.ts";
import { catalogList } from "./chat-pane-catalog.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import type { TestChatPane } from "./chat-pane.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const key = { catalogId: "fixture", hostId: "gateway:local", threadId: "closed-pane" };
const listMethod = "sessions.catalog.list";
const readMethod = "sessions.catalog.read";
const session = {
  threadId: key.threadId,
  status: "stored" as const,
  archived: false,
  canContinue: false,
  canArchive: false,
};
const listed = catalogList(key, [session], {
  capabilities: { continueSession: false, archive: false },
});
const readResult: SessionsCatalogReadResult = {
  hostId: key.hostId,
  threadId: key.threadId,
  items: [{ id: "late-item", type: "agentMessage", text: "Late closed-pane transcript" }],
};

beforeEach(installTranscriptDomMocks);
afterEach(async () => {
  resetTranscriptTestDom();
  await vi.dynamicImportSettled();
});

function mountCatalogPane(request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>) {
  const client = createGatewayBrowserClientFixture();
  vi.spyOn(client, "request").mockImplementation(request);
  const fixture = createRefreshChatPane(client);
  const pane = fixture.pane as unknown as TestChatPane;
  pane.sessionKey = buildCatalogSessionKey(key, "main");
  const loads = vi.spyOn(pane, "loadCatalogSession");
  document.body.append(pane.element);
  return { pane, client, context: fixture.context, loads };
}

function pendingLoads(loads: ReturnType<typeof mountCatalogPane>["loads"]) {
  return loads.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
}

function expectClosed({ pane, context, client }: ReturnType<typeof mountCatalogPane>) {
  expect(pane).toMatchObject({ isConnected: false, state: undefined });
  expect(context.gateway.snapshot.client).toBe(client);
  expect(context.gateway.snapshot.phase).toBe("connected");
}

function waitForRequest(request: Parameters<typeof requestCalls>[0], method: string) {
  return vi.waitFor(() => expect(requestCalls(request, method).length).toBeGreaterThan(0));
}

it.each(["lookup-before", "lookup-after", "read-resolve", "read-reject"] as const)(
  "fences catalog work when disconnecting at %s",
  async (timing) => {
    const lookupStage = timing.startsWith("lookup");
    const lookup = createDeferred<SessionsCatalogListResult>();
    const read = createDeferred<SessionsCatalogReadResult>();
    const pending: Record<string, Promise<unknown>> = {
      [listMethod]: lookup.promise,
      [readMethod]: read.promise,
    };
    const respond = (method: string) => pending[method] ?? Promise.resolve({});
    const request = vi.fn(lookupStage ? respond : async (method: string) => await respond(method));
    if (lookupStage) {
      read.resolve(readResult);
    } else {
      lookup.resolve(listed);
    }
    const fixture = mountCatalogPane(request);
    const { pane, loads } = fixture;
    try {
      await waitForRequest(request, lookupStage ? listMethod : readMethod);
      const active = pendingLoads(loads);
      const readCount = requestCalls(request, readMethod).length;
      const state = pane.state;
      let history = { ...pane.history };
      let error = state.lastError;
      if (lookupStage) {
        if (timing === "lookup-before") {
          pane.remove();
          lookup.resolve(listed);
        } else {
          lookup.resolve(listed);
          // Between the lookup helper resuming and its caller resuming.
          queueMicrotask(() => pane.remove());
        }
      } else {
        pane.remove();
        history = { ...pane.history };
        error = state.lastError;
        if (timing === "read-reject") {
          read.reject(new Error("Late closed-pane failure"));
        } else {
          read.resolve(readResult);
        }
      }
      await Promise.all(active);
      expectClosed(fixture);
      expect.soft(requestCalls(request, readMethod)).toHaveLength(lookupStage ? 0 : readCount);
      expect.soft(pane.history.catalogMessages).toEqual(history.catalogMessages);
      if (lookupStage) {
        expect.soft(pane.history.catalogSession).toEqual(history.catalogSession);
      } else {
        expect.soft(state.lastError).toBe(error);
      }
    } finally {
      pane.remove();
      lookup.resolve(listed);
      read.resolve(readResult);
      await Promise.allSettled(pendingLoads(loads));
    }
  },
);
