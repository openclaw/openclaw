/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DraftWelcome } from "./draft-welcome.tsx";

function row(id: string, label: string, time: number, agent = "main"): GatewaySessionRow {
  return { key: `agent:${agent}:dashboard:${id}`, kind: "direct", label, updatedAt: time };
}

function roster(rows: GatewaySessionRow[], revision = 1) {
  const listeners = new Set<() => void>();
  return {
    state: { result: sessionsResult(rows, revision) },
    listeners,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    publish: () => listeners.forEach((notify) => notify()),
  };
}

it("offers starter suggestions only before the agent's first chat and retires subscriptions", async () => {
  const rows = [row("recent", "Recent", 100)];
  const first = roster(rows);
  let owner = first;
  const options: Parameters<typeof DraftWelcome>[0]["options"] = {
    assistantName: "Assistant",
    assistantAvatar: null,
    sessionKey: "agent:main:main",
    onDraftChange: () => {},
    onSend: () => {},
  };
  const [frame, setFrame] = createSignal({ sessions: owner, options: { ...options } });
  const view = mountSolid(() => <DraftWelcome {...frame()} />);
  const refresh = (patch: Partial<typeof options> = {}) => {
    Object.assign(options, patch);
    setFrame({ sessions: owner, options });
    flush();
  };
  const suggestions = () => view.container.querySelectorAll(".agent-chat__suggestion").length;
  expect(suggestions()).toBe(0);
  expect(first.listeners.size).toBe(1);

  // Faded content parks the roster; the reveal catches up once.
  refresh({ fadeSecondaryContent: true });
  expect(first.listeners.size).toBe(0);
  rows.length = 0;
  first.state.result = sessionsResult([], 2);
  first.publish();
  refresh({ fadeSecondaryContent: false });
  expect(suggestions()).toBeGreaterThan(0);

  const second = roster([row("recent", "Other agent", 1, "other")], 3);
  owner = second;
  refresh({ sessionKey: "agent:other:main" });
  await waitForSolid(() => expect(suggestions()).toBe(0));
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(1);
  view.unmount();
  expect(second.listeners.size).toBe(0);
});

it("does not count the current draft or channel sessions as earlier chats", () => {
  const owner = roster([
    row("current", "Current chat", 50),
    { key: "agent:main:discord:group:g-1456", kind: "group", channel: "discord", updatedAt: 90 },
  ]);
  const view = mountSolid(() => (
    <DraftWelcome
      sessions={owner}
      options={{
        assistantName: "Val",
        assistantAvatar: null,
        sessionKey: "agent:main:dashboard:current",
        onDraftChange: () => {},
        onSend: () => {},
      }}
    />
  ));
  expect(view.container.querySelector(".agent-chat__suggestion")).not.toBeNull();
  expect(view.container.textContent).not.toContain("Recent sessions");
});

it("inserts the displayed tour suggestion into the draft", () => {
  const drafts: string[] = [];
  const view = mountSolid(() => (
    <DraftWelcome
      sessions={roster([])}
      options={{
        assistantName: "Val",
        assistantAvatar: null,
        sessionKey: "agent:main:dashboard:current",
        operatorAuth: { role: "operator", scopes: ["operator.read"] },
        onDraftChange: (draft) => drafts.push(draft),
        onSend: () => {},
      }}
    />
  ));
  const tour = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Tour OpenClaw’s code and docs"),
  );
  expect(tour).toBeDefined();
  tour!.click();
  expect(drafts).toEqual(["Tour OpenClaw’s code and docs"]);
});
