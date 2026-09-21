/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-presence.test/"} */

import { expect, it, onTestFinished, vi } from "vitest";
import type { PresenceEntry } from "../../api/types.ts";
import type { PresencePayload } from "../../app/user-profile.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
} from "./chat-pane.test-support.ts";

const sessionKey = "agent:main:dashboard:presence";

function person(id: string, overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    ts: 1,
    instanceId: `${id}-tab`,
    user: { id, identity: { type: "profile", id }, name: id },
    watchedSessions: [sessionKey],
    ...overrides,
  };
}

async function createPane(presence: PresenceEntry[]) {
  const pane = createRenderTestChatPane() as unknown as Omit<
    ReturnType<typeof createRenderTestChatPane>,
    "presencePayload"
  > & {
    presencePayload: PresencePayload | undefined;
    performUpdate: () => void;
  };
  const context = createInitializationContext(
    createGatewayBrowserClientFixture({ instanceId: "self-tab" }),
  );
  const state = pane.initialize(context);
  pane.sessionKey = sessionKey;
  state.sessionKey = sessionKey;
  state.chatMessages = [{ role: "assistant", content: "Retained conversation", timestamp: 1 }];
  pane.presencePayload = { presence };
  ChatPaneBase.prototype.connectedCallback.call(pane);
  await settleLitElement(pane);
  onTestFinished(() => ChatPaneBase.prototype.disconnectedCallback.call(pane));
  return { pane, context, state, update: vi.spyOn(pane, "performUpdate") };
}

it("keeps an idle pane unchanged for presence heartbeats and unrelated viewers while retaining fresh facts", async () => {
  const { pane, update } = await createPane([
    person("self"),
    person("Riley"),
    person("Alex", { watchedSessions: ["agent:main:other"] }),
  ]);
  const next = {
    presence: [
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
  };

  pane.presencePayload = next;
  await settleLitElement(pane);

  expect(update).not.toHaveBeenCalled();
  expect(pane.presencePayload).toBe(next);
  expect(pane.chatProps?.userName).toBe("self");
});

it.each([
  { name: "viewer arrives", previous: [person("self")], next: [person("self"), person("Riley")] },
  {
    name: "viewer leaves",
    previous: [person("self"), person("Riley")],
    next: [person("self"), person("Riley", { watchedSessions: [] })],
  },
  {
    name: "viewer disconnects",
    previous: [person("self"), person("Riley")],
    next: [person("self"), person("Riley", { reason: "disconnect" })],
  },
  {
    name: "viewer name changes",
    previous: [person("self"), person("Riley")],
    next: [person("self"), person("Riley", { user: { id: "Riley", name: "Renamed viewer" } })],
  },
  {
    name: "viewer avatar changes",
    previous: [person("self"), person("Riley")],
    next: [
      person("self"),
      person("Riley", { user: { id: "Riley", avatarUrl: "/api/users/Riley/avatar?v=2" } }),
    ],
  },
  {
    name: "viewer identity changes",
    previous: [person("self"), person("Riley")],
    next: [
      person("self"),
      person("Riley", {
        user: { id: "Riley", identity: { type: "profile", id: "Riley-merged" }, name: "Riley" },
      }),
    ],
  },
  {
    name: "collaboration becomes available",
    previous: [person("self")],
    next: [person("self"), person("Riley", { watchedSessions: [] })],
  },
])("redraws when $name", async ({ previous, next }) => {
  const { pane, update } = await createPane(previous);

  pane.presencePayload = { presence: next };
  await settleLitElement(pane);

  expect(update).toHaveBeenCalledOnce();
  expect(pane.presencePayload?.presence).toBe(next);
});

it("refreshes the fallback self identity and defers to the authoritative profile", async () => {
  const { pane, context, update } = await createPane([person("self", { watchedSessions: [] })]);
  pane.presencePayload = {
    presence: [
      person("self", {
        watchedSessions: [],
        user: {
          id: "self",
          identity: { type: "profile", id: "self" },
          name: "Updated self",
          avatarUrl: "/api/users/self/avatar?v=2",
        },
      }),
    ],
  };
  await settleLitElement(pane);
  expect(update).toHaveBeenCalledOnce();
  expect(pane.chatProps?.userName).toBe("Updated self");
  expect(pane.chatProps?.userAvatar).toBe("/api/users/self/avatar?v=2");

  context.gateway.snapshot.selfUser = {
    id: "self",
    identity: { type: "profile", id: "self" },
    name: "Authoritative self",
  };
  pane.requestUpdate();
  await settleLitElement(pane);
  update.mockClear();
  pane.presencePayload = {
    presence: [
      person("self", { watchedSessions: [], user: { id: "self", name: "Old tab label" } }),
    ],
  };
  await settleLitElement(pane);
  expect(update).not.toHaveBeenCalled();
  expect(pane.chatProps?.userName).toBe("Authoritative self");
});
