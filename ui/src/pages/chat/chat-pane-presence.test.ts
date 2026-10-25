/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-presence.test/"} */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  connectPaneTestView,
  type TestChatPane,
} from "./chat-pane.test-support.ts";

const sessionKey = "agent:main:dashboard:presence";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function person(id: string, overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    ts: 1,
    instanceId: `${id}-tab`,
    user: { id, identity: { type: "profile", id }, name: id },
    watchedSessions: [sessionKey],
    ...overrides,
  };
}

const withSelf = (...others: PresenceEntry[]) => [person("self"), ...others];
const self = (name: string, avatarUrl?: string) =>
  person("self", {
    watchedSessions: [],
    user: { id: "self", identity: { type: "profile", id: "self" }, name, avatarUrl },
  });
function viewerChange(name: string, overrides: Partial<PresenceEntry>, wasPresent = true) {
  return {
    name,
    previous: withSelf(...(wasPresent ? [person("Riley")] : [])),
    next: withSelf(person("Riley", overrides)),
    updates: 1,
  };
}

async function publishPresence(
  pane: ReturnType<typeof createRenderTestChatPane>,
  presence: PresenceEntry[],
) {
  const payload = { presence };
  pane.presence.update(payload);
  vi.advanceTimersToNextFrame();
  await settleLitElement(pane);
  return payload;
}

async function createPane(presence: PresenceEntry[]) {
  const pane = createRenderTestChatPane();
  const { chatState } = pane as unknown as TestChatPane;
  const context = createInitializationContext(
    createGatewayBrowserClientFixture({ instanceId: "self-tab" }),
  );
  const gatewayListeners = new Set<Parameters<ApplicationContext["gateway"]["subscribe"]>[0]>();
  context.gateway.subscribe = (listener) => {
    gatewayListeners.add(listener);
    return () => gatewayListeners.delete(listener);
  };
  const publishGateway = () =>
    gatewayListeners.forEach((listener) => listener(context.gateway.snapshot));
  const state = pane.initialize(context);
  pane.sessionKey = sessionKey;
  state.sessionKey = sessionKey;
  state.chatMessages = [{ role: "assistant", content: "Retained conversation", timestamp: 1 }];
  pane.presence.update({ presence });
  connectPaneTestView(pane);
  state.renderLifecycle = chatState.createRenderLifecycle();
  chatState.attach(state);
  await settleLitElement(pane);
  onTestFinished(() => pane.disconnectedCallback());
  return { pane, context, publishGateway, update: vi.spyOn(pane, "render") };
}

it.each([
  {
    name: "heartbeats and unrelated viewers",
    previous: withSelf(person("Riley"), person("Alex", { watchedSessions: ["agent:main:other"] })),
    next: [
      person("Alex", {
        ts: 2,
        watchedSessions: ["agent:main:elsewhere"],
        user: { id: "Alex", name: "New remote name" },
      }),
      person("Riley", {
        ts: 2,
        lastInputSeconds: 150,
        onlineSince: 2,
        lastActivityAt: 2,
        platform: "linux",
        deviceFamily: "Desktop",
        timeZone: "Europe/Vienna",
      }),
      person("self", { ts: 2, lastInputSeconds: 10 }),
    ],
    updates: 0,
  },
  viewerChange("viewer leaves", { watchedSessions: [] }),
  viewerChange("viewer name changes", { user: { id: "Riley", name: "Renamed viewer" } }),
  viewerChange("viewer avatar changes", {
    user: { id: "Riley", avatarUrl: "/riley-v2.png" },
  }),
  viewerChange("viewer identity changes", {
    user: { id: "Riley", identity: { type: "profile", id: "Riley-merged" }, name: "Riley" },
  }),
  viewerChange("collaboration becomes available", { watchedSessions: [] }, false),
])(
  "updates presentation only when visible facts change: $name",
  async ({ previous, next, updates }) => {
    const { pane, update } = await createPane(previous);
    const payload = await publishPresence(pane, next);
    expect(update).toHaveBeenCalledTimes(updates);
    expect(pane.presence.snapshot).toBe(payload);
    expect(pane.chatProps?.userName).toBe("self");
  },
);

it("refreshes the fallback self identity and defers to the authoritative profile", async () => {
  const { pane, context, publishGateway, update } = await createPane([self("self")]);
  await publishPresence(pane, [self("Updated self", "/self-v2.png")]);
  expect(update).toHaveBeenCalledOnce();
  expect(pane.chatProps).toMatchObject({ userName: "Updated self", userAvatar: "/self-v2.png" });

  context.gateway.snapshot.selfUser = self("Authoritative self").user;
  publishGateway();
  await settleLitElement(pane);
  update.mockClear();
  await publishPresence(pane, [
    person("self", { watchedSessions: [], user: { id: "self", name: "Old tab label" } }),
  ]);
  expect(update).not.toHaveBeenCalled();
  expect(pane.chatProps?.userName).toBe("Authoritative self");
});

it("retains the known self display name through reconnect and clears it with the identity", async () => {
  const { pane, context, publishGateway } = await createPane([]);
  context.gateway.snapshot.selfUser = self("Alex").user;
  publishGateway();
  await settleLitElement(pane);
  expect(pane.chatProps?.userName).toBe("Alex");

  context.gateway.snapshot.phase = "reconnecting";
  context.gateway.snapshot.selfUser = undefined;
  publishGateway();
  await settleLitElement(pane);
  expect(pane.chatProps?.userName).toBe("Alex");

  context.gateway.snapshot.phase = "connected";
  publishGateway();
  await settleLitElement(pane);
  expect(pane.chatProps?.userName).toBe("Alex");

  context.gateway.snapshot.selfUser = {
    id: "blair",
    identity: { type: "profile", id: "blair" },
    name: "Blair",
  };
  publishGateway();
  await settleLitElement(pane);
  expect(pane.chatProps?.userName).toBe("Blair");

  context.gateway.snapshot.selfUser = null;
  publishGateway();
  await settleLitElement(pane);
  expect(pane.chatProps?.userName).not.toBe("Blair");
});
