/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatComposerNotices } from "../chat-view-notices.ts";
import type { ChatChildAttention } from "./chat-child-attention.ts";

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
  render(
    renderChatComposerNotices({
      sessionKey: parentKey,
      subagentParentKey: parentKey,
      messages: [{ role: "assistant", content: "The diagnostic is running." }],
      subagentSessions: rows,
      onOpenSubagent: open,
    }),
    container,
  );
  const notice = container.querySelector<ChatChildAttention>("openclaw-chat-child-attention");
  expect(notice).not.toBeNull();
  return { container, open, notice: notice! };
}

it("shows the blocked child outcome in its idle parent and opens that exact child", async () => {
  const { container, notice, open } = mount();
  await notice.updateComplete;
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
    const { notice } = mount([failed]);
    await notice.updateComplete;
    expect(notice.querySelector('[role="alert"]')?.textContent).toContain(failed.lastRunError);
    expect(notice.querySelector("img")).toBeNull();
    notice.sessions = [{ ...failed, lastReadAt: now }];
    await notice.updateComplete;
    expect(notice.querySelector(".chat-child-attention")).toBeNull();
  },
);

it("reconciles cleared notes, expiry, and changed parent without retaining stale blockers", async () => {
  const { notice } = mount();
  await notice.updateComplete;
  notice.sessions = [{ ...child, agentStatus: undefined }];
  await notice.updateComplete;
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  notice.sessions = [child];
  await notice.updateComplete;
  notice.sessionKey = "agent:main:dashboard:other";
  await notice.updateComplete;
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
  notice.sessionKey = parentKey;
  await notice.updateComplete;
  expect(notice.querySelector(".chat-child-attention")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(60_001);
  await notice.updateComplete;
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
  const { notice } = mount([
    intermediate,
    nested,
    { ...child, key: "agent:main:subagent:other", spawnedBy: "agent:main:other" },
    { ...child, key: "agent:main:subagent:archived", archived: true },
  ]);
  await notice.updateComplete;
  expect(
    [...notice.querySelectorAll("[data-child-session-key]")].map((node) =>
      node.getAttribute("data-child-session-key"),
    ),
  ).toEqual([childKey]);
  notice.sessions = [{ ...intermediate, archived: true }, nested];
  await notice.updateComplete;
  expect(notice.querySelector(".chat-child-attention")).toBeNull();
});

it("retires its expiry timer when the pane is removed", async () => {
  const { notice } = mount();
  await notice.updateComplete;
  expect(vi.getTimerCount()).toBe(1);
  notice.remove();
  expect(vi.getTimerCount()).toBe(0);
});
