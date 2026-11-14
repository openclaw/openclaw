// @vitest-environment jsdom

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { bindUiPreferences, loadSettings, patchSettings } from "../../app/settings.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import * as presentation from "./chat-inline-command-presentation.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { subscribeChatPaneSettings } from "./chat-pane-startup-subscriptions.ts";
import { createPageState } from "./chat-state-page.ts";

const loadPresentation = presentation.inlineCommandPresentation;
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function page(context = createInitializationContext()) {
  let current = true;
  const state = createPageState(
    context,
    { afterCommit: () => () => {} },
    { sessionKey: "agent:main:main", dispatchEvent: () => true, isCurrent: () => current },
  );
  return { state, retire: () => (current = false) };
}

it("admits a real renderer before persisting inline mode and rejects retired enable requests", async () => {
  const held = createDeferred();
  vi.spyOn(presentation, "inlineCommandPresentation").mockImplementation(async () => {
    await held.promise;
    return loadPresentation();
  });
  onTestFinished(() => held.resolve());
  const request = vi.fn((method: string) =>
    method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
  );
  const client = createTestGatewayClient(request);
  const context = createInitializationContext(client);
  const panes = Array.from({ length: 4 }, () => page(context));
  for (const pane of panes) {
    pane.state.applySettings({ chatInlineCommands: true });
    expect(pane.state.inlineCommandPresentation).toBeUndefined();
    expect(pane.state.settings.chatInlineCommands).not.toBe(true);
  }
  expect(loadSettings().chatInlineCommands).not.toBe(true);
  panes[1]!.state.applySettings({ chatInlineCommands: false });
  panes[2]!.retire();
  panes[3]!.state.settings = { ...panes[3]!.state.settings, gatewayUrl: "ws://successor.test" };

  const peer = page(context).state;
  peer.client = client;
  peer.connected = true;
  onTestFinished(subscribeChatPaneSettings(peer, context));
  const showThinking = !panes[0]!.state.settings.chatShowThinking;
  patchSettings({ chatShowThinking: showThinking });
  held.resolve();
  await vi.waitFor(() =>
    expect(peer.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true),
  );
  const admitted = panes[0]!.state;
  expect(admitted.inlineCommandPresentation?.InlineToolPreview).toBeTypeOf("function");
  expect(loadSettings().chatInlineCommands).toBe(true);
  expect(loadSettings().chatShowThinking).toBe(showThinking);
  for (const pane of panes.slice(1)) {
    expect(pane.state.inlineCommandPresentation).toBeUndefined();
    expect(pane.state.settings.chatInlineCommands).not.toBe(true);
  }
  expect(panes[3]!.state.settings.gatewayUrl).toBe("ws://successor.test");
  expect(request).toHaveBeenCalledWith(
    "sessions.messages.subscribe",
    expect.objectContaining({ includeLiveToolOutput: true }),
    expect.anything(),
  );
  await expect(syncSelectedSessionMessageSubscription(peer)).resolves.toBe(true);
});

it("publishes load failure through the rendered error owner and preserves newer errors on recovery", async () => {
  const loading = vi.spyOn(presentation, "inlineCommandPresentation");
  loading.mockRejectedValue(new Error("Synthetic inline presentation unavailable"));
  const panes = [page().state, page().state];
  for (const state of panes) {
    state.applySettings({ chatInlineCommands: true });
  }
  await vi.waitFor(() => {
    for (const state of panes) {
      expect(state.lastError).toContain("Grouped commands remain available");
      expect(state.lastError).toContain("View");
      expect(state.lastErrorDetail).toEqual(new Error("Synthetic inline presentation unavailable"));
      expect(state.settings.chatInlineCommands).not.toBe(true);
    }
  });
  panes[1]!.setRecoverableChatError("Newer operation failed");
  loading.mockImplementation(loadPresentation);
  for (const state of panes) {
    state.applySettings({ chatInlineCommands: true });
  }
  await vi.waitFor(() => {
    for (const state of panes) {
      expect(state.inlineCommandPresentation).toBeDefined();
      expect(state.settings.chatInlineCommands).toBe(true);
    }
  });
  expect(panes[0]!.lastError).toBeNull();
  expect(panes[1]!.lastError).toBe("Newer operation failed");
});

function savedInlinePane() {
  const row = {
    key: "agent:main:inline-readiness",
    sessionId: "inline-readiness",
    agentId: "main",
    kind: "direct" as const,
    updatedAt: 1,
  };
  const mounted = createMountedPanes([row]);
  // The legacy host constructor also creates an unused context; bind writes to this pane.
  onTestFinished(
    bindUiPreferences({
      gatewayUrl: () => mounted.context.gateway.connection.gatewayUrl,
      refresh: () => mounted.context.theme.refresh(),
    }),
  );
  patchSettings({
    gatewayUrl: mounted.context.gateway.connection.gatewayUrl,
    chatInlineCommands: true,
  });
  const request = vi.spyOn(mounted.context.gateway.snapshot.client!, "request");
  return { pane: mounted.mount(row.key), request };
}

it("withholds saved-enabled startup subscriptions until the real renderer is ready", async () => {
  const held = createDeferred();
  const loading = vi
    .spyOn(presentation, "inlineCommandPresentation")
    .mockImplementation(async () => {
      await held.promise;
      return loadPresentation();
    });
  onTestFinished(() => held.resolve());
  const { pane, request } = savedInlinePane();
  await vi.waitFor(() => expect(loading).toHaveBeenCalled());
  expect(pane.state).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method === "sessions.messages.subscribe")).toBe(
    false,
  );
  held.resolve();
  await waitForSolid(() => {
    expect(pane.querySelector("textarea")).not.toBeNull();
    expect(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
  });
});

it.each([false, true])(
  "recovers a mounted startup failure without clearing newer errors (%s)",
  async (newerError) => {
    vi.spyOn(presentation, "inlineCommandPresentation")
      .mockRejectedValueOnce(new Error("Synthetic startup presentation unavailable"))
      .mockImplementation(loadPresentation);
    const { pane } = savedInlinePane();
    await waitForSolid(() => {
      expect(pane.querySelector("textarea")).not.toBeNull();
      expect(pane.querySelector(".chat-error")?.textContent).toContain(
        "Grouped commands remain available",
      );
      expect(pane.state.lastErrorDetail).toContain("Synthetic startup presentation unavailable");
      expect(pane.state.inlineCommandPresentation).toBeUndefined();
      expect(pane.state.chatSessionMessageSubscription?.key).toBe("agent:main:inline-readiness");
      expect(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput).not.toBe(true);
    });
    const textarea = pane.querySelector("textarea");
    if (newerError) {
      pane.state.setRecoverableChatError("Newer operation failed");
    }
    pane.state.applySettings({ chatInlineCommands: false });
    pane.state.applySettings({ chatInlineCommands: true });
    await waitForSolid(() => {
      expect(pane.state.inlineCommandPresentation).toBeDefined();
      expect(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
      expect(pane.querySelector("textarea")).toBe(textarea);
      if (newerError) {
        expect(pane.querySelector(".chat-error")?.textContent).toContain("Newer operation failed");
      } else {
        expect(pane.querySelector(".chat-error")).toBeNull();
      }
    });
  },
);
