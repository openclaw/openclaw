/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { installColdLoadTitleTrace } from "./cold-load-title.test-support.ts";

it("keeps title diagnostics bounded, private, silent and transparent to the owner", () => {
  const originalWeakMap = window.WeakMap;
  const originalTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  const error = vi.spyOn(console, "error");
  const log = vi.spyOn(console, "log");
  const host = document.createElement("openclaw-chat-pane");
  const heading = document.createElement("span");
  heading.className = "chat-pane__session-title-text";
  host.append(heading);
  document.body.append(host);
  const sessionKey = "agent:main:dashboard:diagnostic-fixture";
  const owner = {
    element: host,
    state: {
      sessionKey,
      sessions: { presentation: { result: null }, state: { result: null } },
    },
    resolveHeaderSessionTitle(row?: { label: string }) {
      return row?.label ?? "New session";
    },
    transcriptSessionProps() {
      return {};
    },
    hydrateStoredChatSnapshot() {},
    applySessionsState() {},
  };
  const originalResolveTitle = owner.resolveHeaderSessionTitle.bind(owner);
  const originalMethod = Object.getOwnPropertyDescriptor(owner, "resolveHeaderSessionTitle");
  try {
    installColdLoadTitleTrace({ sessionKey, expectedTitle: "Expected title" });
    new window.WeakMap().set(host, owner);
    heading.textContent = owner.resolveHeaderSessionTitle({ label: "Expected title" });
    window.coldLoadTitleTrace?.mark("reconcile");
    heading.textContent = owner.resolveHeaderSessionTitle();
    for (let index = 0; index < 200; index++) {
      const input = { label: `Private fixture title ${index}` };
      expect(owner.resolveHeaderSessionTitle(input)).toBe(originalResolveTitle(input));
      heading.textContent = input.label;
    }
    const trace = window.coldLoadTitleTrace?.read();
    expect(trace).toMatchObject({
      events: expect.any(Array),
      dropped: expect.any(Number),
      firstLostTitleWrite: {
        phase: "reconcile",
        property: "textContent",
        title: "New session",
        resolution: expect.any(Number),
      },
    });
    if (!trace) {
      throw new Error("Title trace was not installed");
    }
    const { events, dropped } = trace;
    expect(events).toHaveLength(96);
    expect(dropped).toBeGreaterThan(0);
    expect(JSON.stringify(trace)).not.toContain("Private fixture title");
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    host.remove();
    error.mockRestore();
    log.mockRestore();
    delete window.coldLoadTitleTrace;
  }
  expect(window.WeakMap).toBe(originalWeakMap);
  expect(Object.getOwnPropertyDescriptor(Node.prototype, "textContent")).toEqual(
    originalTextContent,
  );
  expect(Object.getOwnPropertyDescriptor(owner, "resolveHeaderSessionTitle")).toEqual(
    originalMethod,
  );
});
