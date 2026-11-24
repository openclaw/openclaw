// @vitest-environment jsdom

import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { bindUiPreferences, loadSettings, patchSettings } from "../../app/settings.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { subscribeChatPaneSettings } from "./chat-pane-startup-subscriptions.ts";
import { createPageState } from "./chat-state-page.ts";
import * as snapshots from "./session-snapshot-store.ts";

const { loadRow } = vi.hoisted(() => ({ loadRow: vi.fn() }));
vi.mock("./components/chat-tool-card-row.solid.tsx", async (original) => {
  loadRow();
  return original();
});

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("indexedDB", new IDBFactory());
  loadRow.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function page(context = createInitializationContext()) {
  return createPageState(
    context,
    { afterCommit: () => () => {} },
    { sessionKey: "agent:main:main", dispatchEvent: () => true },
  );
}

it("applies inline intent synchronously and admits a peer without loading tool rows", async () => {
  const request = vi.fn((method: string) =>
    method === "sessions.messages.subscribe" ? { key: "agent:main:main" } : {},
  );
  const client = createTestGatewayClient(request);
  const context = createInitializationContext(client);
  const owner = page(context);
  const peer = page(context);
  peer.client = client;
  peer.connected = true;
  onTestFinished(subscribeChatPaneSettings(peer, context));
  const showThinking = !owner.settings.chatShowThinking;
  patchSettings({ chatShowThinking: showThinking });
  owner.applySettings({ chatInlineCommands: true });
  expect(owner.settings.chatInlineCommands).toBe(true);
  expect(loadSettings().chatInlineCommands).toBe(true);
  expect(loadSettings().chatShowThinking).toBe(showThinking);
  await vi.waitFor(() =>
    expect(peer.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true),
  );
  expect(request).toHaveBeenCalledWith(
    "sessions.messages.subscribe",
    expect.objectContaining({ includeLiveToolOutput: true }),
    expect.anything(),
  );
  await expect(syncSelectedSessionMessageSubscription(peer)).resolves.toBe(true);
  expect(loadRow).not.toHaveBeenCalled();
});

it("does not replace an unrelated error when inline intent changes", () => {
  const state = page();
  state.setRecoverableChatError("Another operation failed");
  for (const enabled of [true, false, true]) {
    state.applySettings({ chatInlineCommands: enabled });
    expect(state.settings.chatInlineCommands).toBe(enabled);
    expect(state.lastError).toBe("Another operation failed");
  }
  expect(loadRow).not.toHaveBeenCalled();
});

function savedInlinePane(enabled = true) {
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
    chatInlineCommands: enabled,
  });
  const request = vi.spyOn(mounted.context.gateway.snapshot.client!, "request");
  return { pane: mounted.mount(row.key), request };
}

function pendingSnapshot() {
  const held = createDeferred();
  vi.spyOn(snapshots, "waitForPrewarmedChatSnapshot").mockReturnValue(held.promise);
  onTestFinished(() => held.resolve());
  return held;
}

it("admits saved inline mode after its snapshot without preparing optional tool rows", async () => {
  const snapshot = pendingSnapshot();
  const { pane, request } = savedInlinePane();
  await vi.waitFor(() => expect(snapshots.waitForPrewarmedChatSnapshot).toHaveBeenCalled());
  expect(pane.state).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method === "sessions.messages.subscribe")).toBe(
    false,
  );
  snapshot.resolve();
  await waitForSolid(() => {
    expect(pane.querySelector("textarea")).not.toBeNull();
    expect(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
  });
  expect(loadRow).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses current inline intent after the pending snapshot (initially %s)",
  async (initial) => {
    const snapshot = pendingSnapshot();
    const { pane } = savedInlinePane(initial);
    await vi.waitFor(() => expect(snapshots.waitForPrewarmedChatSnapshot).toHaveBeenCalled());
    patchSettings({ chatInlineCommands: !initial });
    snapshot.resolve();
    await waitForSolid(() => {
      expect(pane.querySelector("textarea")).not.toBeNull();
      // The settings owner omits a disabled optional preference when reloading it.
      expect(pane.state.settings.chatInlineCommands).toBe(initial ? undefined : true);
      expect(Boolean(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput)).toBe(
        !initial,
      );
    });
    expect(loadRow).not.toHaveBeenCalled();
  },
);

it("does not start a pane retired while its snapshot is pending", async () => {
  const snapshot = pendingSnapshot();
  const { pane, request } = savedInlinePane();
  await vi.waitFor(() => expect(snapshots.waitForPrewarmedChatSnapshot).toHaveBeenCalled());
  pane.disconnectedCallback();
  snapshot.resolve();
  await vi.dynamicImportSettled();
  flush();
  expect(pane.state).toBeUndefined();
  expect(request.mock.calls.some(([method]) => method === "sessions.messages.subscribe")).toBe(
    false,
  );
  expect(loadRow).not.toHaveBeenCalled();
});

it("retains the composer and unrelated errors across inline preference changes", async () => {
  const { pane } = savedInlinePane();
  await waitForSolid(() => {
    expect(pane.querySelector("textarea")).not.toBeNull();
    expect(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput).toBe(true);
  });
  const textarea = pane.querySelector("textarea");
  pane.state.setRecoverableChatError("Another operation failed");
  for (const enabled of [false, true]) {
    pane.state.applySettings({ chatInlineCommands: enabled });
    await waitForSolid(() => {
      expect(Boolean(pane.state.chatSessionMessageSubscription?.includeLiveToolOutput)).toBe(
        enabled,
      );
      expect(pane.querySelector("textarea")).toBe(textarea);
      expect(pane.querySelector(".chat-error")?.textContent).toContain("Another operation failed");
    });
  }
  expect(loadRow).not.toHaveBeenCalled();
});
