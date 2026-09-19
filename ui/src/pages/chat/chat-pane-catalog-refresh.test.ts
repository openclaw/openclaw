/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const key = {
  catalogId: "codex",
  hostId: "gateway:local",
  threadId: "thread-101",
} satisfies CatalogSessionKey;

const listResult: SessionsCatalogListResult = {
  catalogs: [
    {
      id: key.catalogId,
      label: "Codex",
      capabilities: { continueSession: false, archive: false },
      hosts: [
        {
          hostId: key.hostId,
          label: "Gateway",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: key.threadId,
              status: "idle",
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

function createCatalogPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
  pane.sessionKey = state.sessionKey = buildCatalogSessionKey(key, "main");
  return { pane, state };
}

describe("catalog refresh publication", () => {
  it("does not publish when pane ownership retires after page loading", async () => {
    let readCount = 0;
    const request = vi.fn(async (method: string, params?: { cursor?: string }) => {
      if (method === "sessions.catalog.list") {
        return listResult;
      }
      readCount += 1;
      if (readCount === 1) {
        return {
          hostId: key.hostId,
          threadId: key.threadId,
          items: [{ id: "retained", type: "agentMessage", text: "Retained answer" }],
        } satisfies SessionsCatalogReadResult;
      }
      if (!params?.cursor) {
        return {
          hostId: key.hostId,
          threadId: key.threadId,
          items: [{ id: "latest", type: "agentMessage", text: "Latest answer" }],
          nextCursor: "older",
        } satisfies SessionsCatalogReadResult;
      }
      return {
        hostId: key.hostId,
        threadId: key.threadId,
        items: [{ id: "retained", type: "agentMessage", text: "Retained answer" }],
      } satisfies SessionsCatalogReadResult;
    });
    const { pane, state } = createCatalogPane(request);
    await pane.loadCatalogSession(key, false);
    const retainedMessages = pane.catalogMessages;
    state.lastError = "Retained error";
    const project = pane.catalogItemMessage.bind(pane);
    let retirementQueued = false;
    pane.catalogItemMessage = (item) => {
      if (item.id === "retained" && readCount > 1 && !retirementQueued) {
        retirementQueued = true;
        queueMicrotask(() => {
          pane.catalogLoadGeneration += 1;
        });
      }
      return project(item);
    };

    await expect(pane.loadCatalogSession(key, false, true)).resolves.toBe(false);

    expect(pane.catalogMessages).toBe(retainedMessages);
    expect(state.lastError).toBe("Retained error");
  });

  it("preserves shifted ID-less history through the actual catalog projector", async () => {
    const item = (text: string): SessionCatalogTranscriptItem => ({
      type: "agentMessage",
      text,
    });
    let readCount = 0;
    const request = vi.fn(async (method: string, params?: { cursor?: string }) => {
      if (method === "sessions.catalog.list") {
        return listResult;
      }
      readCount += 1;
      if (readCount === 1) {
        return {
          hostId: key.hostId,
          threadId: key.threadId,
          items: [item("D"), item("C"), item("B"), item("A")],
        } satisfies SessionsCatalogReadResult;
      }
      if (!params?.cursor) {
        return {
          hostId: key.hostId,
          threadId: key.threadId,
          items: [item("H"), item("G"), item("F"), item("E")],
          nextCursor: "older",
        } satisfies SessionsCatalogReadResult;
      }
      return {
        hostId: key.hostId,
        threadId: key.threadId,
        items: [item("D"), item("C"), item("B")],
      } satisfies SessionsCatalogReadResult;
    });
    const { pane } = createCatalogPane(request);

    await pane.loadCatalogSession(key, false);
    await pane.loadCatalogSession(key, false, true);

    expect(
      pane.catalogMessages.map(
        (message) => (message as { content: Array<{ text: string }> }).content[0]?.text,
      ),
    ).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.read",
      expect.objectContaining({ cursor: "older" }),
    );
  });
});
