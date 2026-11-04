/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../../../packages/gateway-protocol/src/schema/human-mentions.js";
import { createDeferredCore } from "../../../../../src/shared/deferred.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import {
  sessionsResult,
  createTestSessionCapability,
} from "../../../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../../../lib/sessions/session-capability.ts";
import { welcomeSessionListQuery } from "../../../lib/sessions/session-requests.ts";
import { createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
import { prepareWelcomeRecentSessions } from "./chat-welcome.ts";
import { ChatWelcome } from "./chat-welcome.tsx";

function roster(result: SessionsListResult) {
  const listeners = new Set<(snapshot: SessionListSnapshot) => void>();
  const snapshot = (): SessionListSnapshot => ({
    result,
    agentId: "main",
    loading: false,
    error: null,
  });
  const sessions = createSessionCapabilityFixture({
    state: { result },
    listSnapshot: snapshot,
    refreshList: async () => {},
    subscribeList(_scope, notify) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  });
  return {
    sessions,
    listeners,
    publish() {
      for (const notify of listeners) {
        notify(snapshot());
      }
    },
  };
}

it("prepares recents only for their owner and scope, parks display facts, and retires subscriptions", async () => {
  let rosterReads = 0;
  let oldestAt = 1;
  const oldest: GatewaySessionRow = {
    key: "agent:main:dashboard:old",
    kind: "direct",
    lastInteractionAt: 1,
    label: "Oldest",
    get updatedAt() {
      rosterReads += 1;
      return oldestAt;
    },
  };
  const rows: GatewaySessionRow[] = Array.from({ length: 5 }, (_, index) => ({
    key: "agent:main:dashboard:recent-" + index,
    kind: "direct",
    lastInteractionAt: 1,
    label: "Recent " + index,
    updatedAt: 100 + index,
  }));
  const first = roster(sessionsResult([...rows, oldest], 1));
  let owner = first;
  const options: Parameters<typeof ChatWelcome>[0] = {
    assistantName: "Assistant",
    assistantAvatar: null,
    sessionKey: "agent:main:main",
    onDraftChange: () => {},
    onSend: () => {},
  };
  const gateway = createGatewayHarness(createTestGatewayClient(() => ({})));
  gateway.publish({
    selfUser: { id: "viewer" },
    hello: {
      ...gateway.gateway.snapshot.hello!,
      policy: { hasMultipleSessionSharingIdentities: false },
    },
  });
  let context = { gateway: gateway.gateway, sessions: owner.sessions };
  const [frame, setFrame] = createSignal({ ...options, applicationContext: context });
  const view = mountSolid(() => <ChatWelcome {...frame()} />);
  const refresh = () => {
    if (context.sessions !== owner.sessions) {
      context = { gateway: gateway.gateway, sessions: owner.sessions };
    }
    setFrame({ ...options, applicationContext: context });
    flush();
  };
  const recentName = () => view.container.querySelector(".agent-chat__recent-name")?.textContent;
  expect(recentName()).toBe("Recent 4");
  expect(rosterReads).toBeGreaterThan(0);
  expect(first.listeners.size).toBe(1);
  rosterReads = 0;

  options.assistantName = "Assistant refreshed";
  refresh();
  expect(view.container.querySelector("h2")?.textContent).toBe("Assistant refreshed");
  expect(rosterReads).toBe(0);
  options.fadeSecondaryContent = true;
  refresh();
  expect(first.listeners.size).toBe(0);
  oldest.label = "Moved newest";
  oldestAt = 1000;
  rows[4]!.label = "Changed while hidden";
  first.publish();
  for (const name of ["Typing a", "Typing ab", "Typing abc"]) {
    options.assistantName = name;
    refresh();
  }
  expect(rosterReads).toBe(0);
  expect(recentName()).toBe("Recent 4");

  options.fadeSecondaryContent = false;
  refresh();
  expect(rosterReads).toBeGreaterThan(0);
  expect(recentName()).toBe("Moved newest");
  expect(view.container.textContent).toContain("Changed while hidden");
  oldest.label = "Visible newest";
  first.publish();
  flush();
  expect(recentName()).toBe("Visible newest");

  const second = roster(
    sessionsResult(
      [
        {
          key: "agent:other:dashboard:recent",
          kind: "direct",
          label: "Other agent",
          updatedAt: 1,
          lastInteractionAt: 1,
        },
      ],
      2,
    ),
  );
  owner = second;
  options.sessionKey = "agent:other:main";
  refresh();
  await waitForSolid(() => expect(recentName()).toBe("Other agent"));
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(1);
  rosterReads = 0;
  first.publish();
  flush();
  expect(rosterReads).toBe(0);
  expect(recentName()).toBe("Other agent");
  view.unmount();
  expect(second.listeners.size).toBe(0);
});

it("withholds the team roster while identity resolves and retires a late personal query on agent change", async () => {
  const late = createDeferredCore<SessionsListResult>();
  const shared = {
    key: "agent:research:dashboard:shared",
    kind: "direct" as const,
    lastInteractionAt: 1,
    label: "Shared with me",
    updatedAt: 1,
  };
  const request = vi.fn(async (_method: string, params?: unknown) => {
    if (typeof params !== "object" || !params || !("involvingMe" in params)) {
      return sessionsResult([broad]);
    }
    return "agentId" in params && params.agentId === "main"
      ? late.promise
      : sessionsResult([shared]);
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    selfUser: undefined,
    hello: {
      ...gateway.gateway.snapshot.hello!,
      policy: { hasMultipleSessionSharingIdentities: true },
    },
  });
  const sessions = createTestSessionCapability(gateway.gateway);
  const broad = {
    key: "agent:main:dashboard:other",
    kind: "direct" as const,
    lastInteractionAt: 1,
    label: "Someone else's chat",
    updatedAt: 100,
  };
  await sessions.refresh({ agentId: "main" });
  const [sessionKey, setSessionKey] = createSignal("agent:main:main");
  const view = mountSolid(() => (
    <ChatWelcome
      applicationContext={{ gateway: gateway.gateway, sessions }}
      sessionKey={sessionKey()}
      assistantName="Assistant"
      assistantAvatar={null}
      onDraftChange={() => {}}
      onSend={() => {}}
    />
  ));
  const names = () =>
    Array.from(
      view.container.querySelectorAll(".agent-chat__recent-name"),
      (row) => row.textContent,
    );
  expect(names()).toEqual([]);
  gateway.publish({ selfUser: { id: "alice" } });
  flush();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ involvingMe: true, agentId: "main" }),
    ),
  );
  expect(names()).toEqual([]);
  setSessionKey("agent:research:main");
  flush();
  await waitForSolid(() => expect(names()).toEqual(["Shared with me"]));
  late.resolve(sessionsResult([{ ...broad, label: "Late previous-agent chat" }]));
  await waitForSolid(() =>
    expect(sessions.listSnapshot(welcomeSessionListQuery("main", true)).loading).toBe(false),
  );
  expect(names()).toEqual(["Shared with me"]);
  expect(sessions.state.result?.sessions.map((row) => row.label)).toEqual(["Someone else's chat"]);
  view.unmount();
});

it("keeps mentions out of rank, uses the shared unread flag, and drops hidden, snoozed, archived and empty rows", () => {
  const now = 1_800_000_000_000;
  const displayRow = (
    id: string,
    updatedAt: number,
    unread = false,
    fields: Partial<GatewaySessionRow> = {},
  ): GatewaySessionRow => ({
    key: "agent:main:dashboard:" + id,
    kind: "direct",
    label: id,
    lastInteractionAt: 1,
    updatedAt,
    unread,
    ...fields,
  });
  const source = sessionsResult([
    displayRow("read-new", 100),
    displayRow("read-mentioned", 50),
    displayRow("unread-b", 20, true),
    displayRow("unread-a", 20, true),
    displayRow("unread-new", 30, true),
    displayRow("hidden", 500, true, { hiddenFromInvolvingMe: true }),
    displayRow("snoozed", 400, true, { snoozedUntil: now + 1000 }),
    displayRow("archived", 300, true, { archived: true }),
    displayRow("empty", 200, true, { lastInteractionAt: undefined }),
  ]);
  const mention: MentionInboxItem = {
    id: "current",
    agentId: "main",
    sessionKey: "agent:main:dashboard:read-mentioned",
    sessionTitle: "read-mentioned",
    senderProfileId: "maya",
    senderLabel: "Maya",
    messageId: "message",
    createdAt: now - 1,
    expiresAt: now + 1000,
  };
  const read = (mentions: readonly MentionInboxItem[]) =>
    prepareWelcomeRecentSessions(source, "agent:main:main", "main", mentions, now);
  const prepared = read([mention]);
  expect(prepared.map((row) => [row.name, row.unread])).toEqual([
    ["unread-new", true],
    ["unread-a", true],
    ["unread-b", true],
    ["read-new", false],
    ["read-mentioned", false],
  ]);
  expect(prepared[4]?.mention?.senderLabel).toBe("Maya");
  expect(
    prepareWelcomeRecentSessions(
      sessionsResult(source.sessions.slice(5)),
      "agent:main:main",
      "main",
      [],
      now,
    ),
  ).toEqual([]);
  expect(read([]).map((row) => row.key)).toEqual(prepared.map((row) => row.key));
  expect(read([{ ...mention, expiresAt: now }]).every((row) => !row.mention)).toBe(true);
  expect(read([{ ...mention, agentId: "research" }]).every((row) => !row.mention)).toBe(true);
});
