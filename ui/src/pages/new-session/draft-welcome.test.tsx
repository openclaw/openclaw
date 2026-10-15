/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DraftWelcome } from "./draft-welcome.tsx";

function roster(result: SessionsListResult) {
  const listeners = new Set<() => void>();
  return {
    state: { result },
    listeners,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    publish() {
      for (const notify of listeners) {
        notify();
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
    label: "Oldest",
    get updatedAt() {
      rosterReads += 1;
      return oldestAt;
    },
  };
  const rows: GatewaySessionRow[] = Array.from({ length: 5 }, (_, index) => ({
    key: "agent:main:dashboard:recent-" + index,
    kind: "direct",
    label: "Recent " + index,
    updatedAt: 100 + index,
  }));
  const first = roster(sessionsResult([...rows, oldest], 1));
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
  const refresh = () => {
    setFrame({ sessions: owner, options });
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
      [{ key: "agent:other:dashboard:recent", kind: "direct", label: "Other agent", updatedAt: 1 }],
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
