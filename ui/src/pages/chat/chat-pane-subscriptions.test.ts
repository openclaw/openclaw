/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import { localEditorFilePath } from "../../app/native-editor-locality.runtime.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
} from "../../app/native-gateways.runtime.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-application-context.test-support.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  connectPaneTestView,
  createRenderTestChatPane,
  createTestChatPane,
  getPaneTestRuntime,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";

describe("chat pane approval replay subscriptions", () => {
  it("preserves live approval transitions received while session replay is awaiting publication", async () => {
    const { state } = createTestChatPane({ client: createTestGatewayClient(vi.fn()) });
    const started = createDeferred();
    const replay = createDeferred<Awaited<ReturnType<typeof state.sessions.subscribeMessages>>>();
    vi.spyOn(state.sessions, "subscribeMessages").mockImplementation(() => {
      started.resolve();
      return replay.promise;
    });
    const pending = {
      id: "exec:original",
      status: "pending" as const,
      presentation: {
        kind: "exec" as const,
        commandText: "echo original",
        allowedDecisions: ["allow-once", "deny"] as const,
      },
      urlPath: "/approve/exec%3Aoriginal",
      createdAtMs: 1,
      expiresAtMs: 10_000,
    };
    const sync = syncSelectedSessionMessageSubscription(state);
    await started.promise;
    for (const payload of [
      {
        sessionKey: state.sessionKey,
        phase: "terminal",
        updatedAtMs: 2,
        approval: {
          ...pending,
          status: "denied",
          decision: "deny",
          reason: "user",
          resolvedAtMs: 2,
        },
      },
      {
        sessionKey: state.sessionKey,
        phase: "pending",
        updatedAtMs: 3,
        approval: { ...pending, id: "exec:new-live", urlPath: "/approve/exec%3Anew-live" },
      },
    ]) {
      handlePageGatewayEvent(state, { type: "event", event: "session.approval", payload });
    }
    replay.resolve({
      key: state.sessionKey,
      agentId: null,
      includeApprovals: true,
      approvalReplay: {
        sessionKey: state.sessionKey,
        updatedAtMs: 1,
        approvals: [pending],
        truncated: false,
      },
    });
    await sync;
    expect(state.chatSessionApprovalQueue?.map((entry) => entry.id)).toEqual(["exec:new-live"]);
  });

  it.each([false, true])(
    "uses the global pending queue for truncated or retired session replays (%s)",
    async (truncated) => {
      const key = "agent:main:pending-replay";
      const client = createTestGatewayClient(async (method) =>
        method === "sessions.messages.subscribe"
          ? {
              key,
              agentId: "main",
              approvalReplay: { sessionKey: key, updatedAtMs: 1, approvals: [], truncated },
            }
          : {},
      );
      const approval: ExecApprovalRequest = {
        id: "exec:global-pending",
        kind: "exec",
        request: { command: "echo pending", agentId: "main", sessionKey: key },
        createdAtMs: 1,
        expiresAtMs: Date.now() + 60_000,
      };
      const context: ApplicationContext = {
        ...createInitializationContext(client),
        overlays: {
          snapshot: {
            approvalQueue: [approval],
            approvalBusy: false,
            approvalCanGrant: true,
            approvalErrors: new Map(),
          },
          decideApproval: vi.fn(),
        } as unknown as ApplicationContext["overlays"],
      };
      const pane = createRenderTestChatPane();
      const state = pane.initialize(context);
      pane.sessionKey = key;
      state.sessionKey = key;
      state.client = client;
      state.connected = true;
      state.hello = gatewayHelloForMethods(["sessions.messages.subscribe"]);
      try {
        expect(await syncSelectedSessionMessageSubscription(state)).toBe(true);
        pane.render();
        expect(pane.chatProps?.inlineApproval).toBe(truncated ? approval : null);
        state.connectionEpoch += 1;
        pane.render();
        expect(pane.chatProps?.inlineApproval).toBe(approval);
      } finally {
        if (state.chatSessionMessageSubscription) {
          await state.sessions.unsubscribeMessages(state.chatSessionMessageSubscription);
        }
        chatRunPresentation(state).cancelFrame();
      }
    },
  );
});

function observeRender<T>(pane: TestChatPane, read: () => T) {
  const rendered: T[] = [];
  const render = vi.fn(() => {
    rendered.push(read());
    return { layout: null, capabilityDialogs: undefined, providerReviewSource: undefined };
  });
  pane.render = render;
  const settle = async () => {
    await Promise.resolve();
    flush();
  };
  return {
    rendered,
    render,
    expectUpdate: async (change: () => void, expected: T, parked = false) => {
      if (parked) {
        pane.presented = false;
        await settle();
        render.mockClear();
      }
      change();
      expect(read()).toBe(expected);
      if (parked) {
        await settle();
        expect(render).not.toHaveBeenCalled();
        pane.presented = true;
        await pane.updateComplete;
        expect(rendered.at(-1)).toBe(expected);
      } else {
        await waitForSolid(() => expect(rendered.at(-1)).toBe(expected));
      }
    },
  };
}

it("projects composer capability changes and catches up a parked pane on reveal", async () => {
  const fixture = createMountedPanes([{ key: "main", kind: "direct", updatedAt: 1 }]);
  const { pane } = fixture;
  const capabilities = getPaneTestRuntime(pane).composerCapabilities;
  const view = () => capabilities.dialogView(pane.context, pane.state, undefined);
  const { render, expectUpdate } = observeRender(pane, () => view().open);
  fixture.mount("main");
  await pane.updateComplete;

  await expectUpdate(
    () => capabilities.props(pane.context, pane.state, undefined, "main").onAddServer?.(),
    true,
  );
  await expectUpdate(() => view().onCancel(), false, true);

  const state = pane.state;
  const reopen = capabilities.props(pane.context, state, undefined, "main").onAddServer;
  pane.disconnectedCallback();
  render.mockClear();
  reopen?.();
  expect(capabilities.dialogView(pane.context, state, undefined).open).toBe(true);
  flush();
  expect(render).not.toHaveBeenCalled();
});

const native = vi.hoisted(() => ({ capability: null as NativeGatewaysCapability | null }));
vi.mock("../../app/native-gateways.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/native-gateways.runtime.ts")>()),
  nativeGatewaysCapability: () => native.capability,
}));

it("updates native locality synchronously and catches up parked panes on reveal", async () => {
  let snapshot: NativeGatewaysSnapshot = {
    currentId: "local",
    gateways: (["local", "remote"] as const).map((kind) => ({
      id: kind,
      name: kind === "local" ? "Local" : "Remote",
      kind,
      isPrimary: kind === "local",
      canPromote: kind === "remote",
      health: "ok" as const,
    })),
  };
  const listeners = new Set<(next: NativeGatewaysSnapshot) => void>();
  native.capability = {
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: vi.fn(),
    setPrimary: vi.fn(),
    openSettings: vi.fn(),
  };
  const publish = (currentId: string) => {
    snapshot = { ...snapshot, currentId };
    listeners.forEach((listener) => listener(snapshot));
  };
  const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const file = { path: "file.ts", root: "/workspace" };
  const { rendered, expectUpdate } = observeRender(pane, () => localEditorFilePath(file));
  onTestFinished(() => {
    pane.disconnectedCallback();
    native.capability = null;
  });
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(rendered.at(-1)).toBe("/workspace/file.ts");

  await expectUpdate(() => publish("remote"), null);
  await expectUpdate(() => publish("local"), "/workspace/file.ts", true);

  pane.disconnectedCallback();
  expect(listeners.size).toBe(0);
  publish("remote");
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(rendered.at(-1)).toBeNull();
});

it("parks and remounts presentation subscriptions using the runtime's context without a provider", async () => {
  const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const navigation = pane.context.navigation;
  const subscribe = navigation.subscribe.bind(navigation);
  const released = vi.fn();
  const subscriptions = vi.spyOn(navigation, "subscribe").mockImplementation((listener) => {
    const stop = subscribe(listener);
    return () => {
      released();
      stop();
    };
  });
  const pluginSubscriptions = vi.spyOn(pane.context.plugins, "subscribe");
  const { rendered, render, expectUpdate } = observeRender(
    pane,
    () => navigation.snapshot.navCollapsed,
  );
  onTestFinished(() => {
    pane.disconnectedCallback();
    vi.restoreAllMocks();
  });
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(subscriptions).toHaveBeenCalledOnce();
  expect(pluginSubscriptions).toHaveBeenCalledOnce();

  await expectUpdate(() => navigation.update({ navCollapsed: true }), true);
  await expectUpdate(() => navigation.update({ navCollapsed: false }), false, true);

  pane.disconnectedCallback();
  expect(released).toHaveBeenCalledTimes(subscriptions.mock.calls.length);
  const acquired = subscriptions.mock.calls.length;
  render.mockClear();
  navigation.update({ navCollapsed: true });
  await Promise.resolve();
  flush();
  expect(render).not.toHaveBeenCalled();
  expect(subscriptions).toHaveBeenCalledTimes(acquired);

  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(subscriptions).toHaveBeenCalledTimes(acquired + 1);
  expect(rendered.at(-1)).toBe(true);
});

it("retires auth presentation once per event and releases the Gateway listener on disconnect", async () => {
  const key = "agent:main:subscription-auth";
  const authStatus = { ts: 43, providers: [] };
  const fixture = createMountedPanes(
    [{ key, agentId: "main", kind: "direct", sessionId: "subscription-auth", updatedAt: 1 }],
    "main",
    undefined,
    { "models.authStatus": () => authStatus },
  );
  const pane = fixture.mount(key);
  const ready = async () => {
    await pane.updateComplete;
    await waitForSolid(() =>
      expect(pane.state).toMatchObject({ connected: true, chatLoading: false }),
    );
  };
  await ready();

  for (let connection = 0; connection < 2; connection += 1) {
    const state = pane.state;
    const previous = { ts: 42, providers: [] };
    state.modelAuthStatusResult = previous;
    const version = state.modelAuthStatusRequestVersion;
    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: false });
    expect(state.modelAuthStatusResult).toBe(previous);
    expect(state.modelAuthStatusRequestVersion).toBe(version);

    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: true });
    expect(state.modelAuthStatusResult).toBeNull();
    expect(state.modelAuthStatusRequestVersion).toBe(version + 1);
    await waitForSolid(() => expect(state.modelAuthStatusResult).toEqual(authStatus));
    const settled = state.modelAuthStatusResult;
    const settledVersion = state.modelAuthStatusRequestVersion;
    pane.disconnectedCallback();
    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: true });
    expect(state.modelAuthStatusResult).toBe(settled);
    expect(state.modelAuthStatusRequestVersion).toBe(settledVersion);
    if (connection === 0) {
      pane.connectedCallback();
      await ready();
    }
  }
});
