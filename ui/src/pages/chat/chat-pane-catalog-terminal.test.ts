/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { catalogList } from "./chat-pane-catalog.test-support.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([
  { allowed: true, pending: false },
  { allowed: false, pending: false },
  { allowed: true, pending: true },
])(
  "rechecks continuation after terminal exit (allowed=$allowed, pending=$pending)",
  async ({ allowed, pending }) => {
    const key = { catalogId: "codex", hostId: "gateway:local", threadId: "native-thread" };
    let canContinue = false;
    const fixture = createMountedPanes([]);
    const page = {
      ...key,
      items: [{ id: "answer", type: "agentMessage", text: "Native answer" }],
      nextCursor: "older-page",
    };
    const firstPage = createDeferred<typeof page>();
    onTestFinished(() => firstPage.resolve(page));
    let transcriptReads = 0;
    const client = fixture.state.client!;
    const originalRequest = client.request.bind(client);
    const request = vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
      if (method === "sessions.catalog.list") {
        return catalogList(key, [
          {
            threadId: key.threadId,
            status: "idle",
            archived: false,
            canArchive: true,
            canContinue,
          },
        ]);
      }
      if (method === "sessions.catalog.read") {
        return pending && transcriptReads++ === 0 ? firstPage.promise : page;
      }
      if (method === "sessions.catalog.continue") {
        return { sessionKey: "agent:main:continued" };
      }
      return originalRequest(method, ...args);
    });
    const pane = fixture.mount(buildCatalogSessionKey(key, "main"));
    await vi.waitFor(() => expect(pane.history.catalogSession?.canContinue).toBe(false));
    if (!pending) {
      await vi.waitFor(() => expect(pane.history.catalogLoading).toBe(false));
    }
    const retained = [{ role: "assistant", content: "Previously loaded older answer" }];
    if (!pending) {
      pane.history.catalogMessages = retained;
    }
    pane.state.chatMessage = "Continue this conversation";
    pane.onPaneSessionChange = vi.fn();
    await pane.continueCatalogSession(key);
    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();

    pane.presented = false;
    canContinue = allowed;
    const reads = request.mock.calls.filter(
      ([method]) => method === "sessions.catalog.list",
    ).length;
    fixture.emitGatewayEvent("terminal.exit", {
      sessionId: "native-terminal",
      reason: "process_exit",
      exitCode: 0,
    });
    pane.presented = true;
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.catalog.list").length,
      ).toBe(reads + 1),
    );
    await vi.waitFor(() => expect(pane.history.catalogSession?.canContinue).toBe(allowed));
    if (pending) {
      await vi.waitFor(() => expect(pane.history.catalogMessages).toHaveLength(1));
      expect(pane.history.catalogMessages[0]).toMatchObject({
        content: [{ text: "Native answer" }],
      });
    } else {
      expect(pane.history.catalogMessages).toBe(retained);
    }
    expect(pane.history.catalogCursor).toBe("older-page");
    await pane.continueCatalogSession(key);
    expect(pane.onPaneSessionChange).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(pane.onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:continued");
    }
  },
);
