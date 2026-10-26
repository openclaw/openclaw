import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { renderChatComposerNotices } from "../chat-view-notices.tsx";

const parentKey = "agent:main:dashboard:parent";
const childKey = "agent:main:subagent:diagnostic";
const now = 10_000;
const child: GatewaySessionRow = {
  key: childKey,
  kind: "direct",
  label: "Debugger diagnostic",
  spawnedBy: parentKey,
  status: "done",
  endedAt: now,
  agentStatus: {
    note: "Blocked: debugger attempt expired; no attach or visible prompt verified.",
    attention: "key",
    expiresAt: now + 60_000,
  },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(rows: GatewaySessionRow[] = [child]) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const container = document.body.appendChild(document.createElement("div"));
  const open = vi.fn();
  // Reproduce the parent entry point: no run error or new assistant message.
  let props: Parameters<typeof renderChatComposerNotices>[0] = {
    sessionKey: parentKey,
    subagentParentKey: parentKey,
    messages: [{ role: "assistant", content: "The diagnostic is running." }],
    subagentSessions: rows,
    subagentSessionsRead: true,
    onOpenSubagent: open,
  };
  const view = mountSolid(renderChatComposerNotices, props, container);
  const notice = container.querySelector<HTMLElement>("openclaw-chat-child-attention");
  expect(notice).not.toBeNull();
  return {
    container,
    open,
    notice: notice!,
    unmount: view.dispose,
    update(this: void, changes: Partial<typeof props>) {
      props = { ...props, ...changes };
      view.update(props);
    },
  };
}

it("shows the blocked child outcome in its idle parent and opens that exact child", async () => {
  const { container, open } = mount();
  flush();
  const card = container.querySelector(".chat-child-attention");
  expect(card?.getAttribute("role")).toBe("status");
  expect(card?.textContent).toContain(child.label);
  expect(card?.textContent).toContain(child.agentStatus!.note);
  expect(card?.querySelector("details")).toBeNull();
  card?.querySelector<HTMLButtonElement>("button")?.click();
  expect(open).toHaveBeenCalledExactlyOnceWith(childKey);
});

it.each(["failed", "timeout"] as const)(
  "shows an unread %s child diagnostic and clears after acknowledgement",
  async (status) => {
    const failed = {
      ...child,
      status,
      agentStatus: undefined,
      lastRunError: "Diagnostic failed <img src=x>",
    };
    const { notice, update } = mount([failed]);
    flush();
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(failed.lastRunError);
    expect(notice.querySelector("img")).toBeNull();
    update({ subagentSessions: [{ ...failed, suppressErrorNotice: true }] });
    flush();
    expect(notice.querySelector(".chat-child-attention")).toBeNull();
    update({ subagentSessions: [failed] });
    flush();
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(failed.lastRunError);
    update({ subagentSessions: [{ ...failed, lastReadAt: now }] });
    flush();
    expect(notice.querySelector(".chat-child-attention")).toBeNull();
  },
);

it("reconciles cleared notes, expiry, and changed parent without retaining stale blockers", async () => {
  const { notice, update } = mount();
  flush();
  update({ subagentSessions: [{ ...child, agentStatus: undefined }] });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  update({ subagentSessions: [child] });
  flush();
  update({ subagentParentKey: "agent:main:dashboard:other" });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  update({ subagentParentKey: parentKey });
  flush();
  expect(notice.querySelector(".chat-child-attention")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(60_001);
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses sidebar ancestry for nested outcomes and excludes unrelated or archived branches", async () => {
  const intermediate: GatewaySessionRow = {
    key: "agent:main:subagent:coordinator",
    kind: "direct",
    spawnedBy: parentKey,
  };
  const nested = { ...child, spawnedBy: intermediate.key };
  const { notice, update } = mount([
    intermediate,
    nested,
    { ...child, key: "agent:main:subagent:other", spawnedBy: "agent:main:other" },
    { ...child, key: "agent:main:subagent:archived", archived: true },
  ]);
  flush();
  expect(
    [...notice.querySelectorAll("[data-child-session-key]")].map((node) =>
      node.getAttribute("data-child-session-key"),
    ),
  ).toEqual([childKey]);
  update({ subagentSessions: [{ ...intermediate, archived: true }, nested] });
  flush();
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
});

it("retires its expiry timer when the pane is removed", async () => {
  const { unmount } = mount();
  flush();
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
