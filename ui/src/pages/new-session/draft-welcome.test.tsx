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

it("prepares recents only for their owner and scope, parks display facts, and retires subscriptions", async () => {
  let rosterReads = 0;
  let oldestAt = 1;
  const oldest: GatewaySessionRow = {
    ...row("old", "Oldest", oldestAt),
    get updatedAt() {
      rosterReads += 1;
      return oldestAt;
    },
  };
  const rows = Array.from({ length: 5 }, (_, i) => row(`recent-${i}`, `Recent ${i}`, 100 + i));
  const first = roster([...rows, oldest]);
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
  const recentName = () => view.container.querySelector(".agent-chat__recent-name")?.textContent;
  const displayed = () => [recentName(), rosterReads, owner.listeners.size];
  expect(recentName()).toBe("Recent 4");
  expect(first.listeners.size).toBe(1);
  expect(rosterReads).toBeGreaterThan(0);
  rosterReads = 0;

  refresh({ assistantName: "Assistant refreshed" });
  expect(view.container.querySelector("h2")?.textContent).toBe("Assistant refreshed");
  expect(rosterReads).toBe(0);
  refresh({ fadeSecondaryContent: true });
  expect(first.listeners.size).toBe(0);
  oldest.label = "Moved newest";
  oldestAt = 1000;
  rows[4]!.label = "Changed while hidden";
  first.publish();
  for (const name of ["Typing a", "Typing ab", "Typing abc"]) {
    refresh({ assistantName: name });
  }
  expect(displayed()).toEqual(["Recent 4", 0, 0]);

  refresh({ fadeSecondaryContent: false });
  expect(rosterReads).toBeGreaterThan(0);
  expect(recentName()).toBe("Moved newest");
  expect(view.container.textContent).toContain("Changed while hidden");
  oldest.label = "Visible newest";
  first.publish();
  flush();
  expect(recentName()).toBe("Visible newest");

  const second = roster([row("recent", "Other agent", 1, "other")], 2);
  owner = second;
  refresh({ sessionKey: "agent:other:main" });
  await waitForSolid(() => expect(recentName()).toBe("Other agent"));
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(1);
  rosterReads = 0;
  first.publish();
  flush();
  expect(displayed()).toEqual(["Other agent", 0, 1]);
  view.unmount();
  expect(second.listeners.size).toBe(0);
});
