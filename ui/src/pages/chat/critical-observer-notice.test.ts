/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CriticalObserverNoticeTracker,
  showCriticalSessionObserverNotice,
} from "./critical-observer-notice.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("critical session observer notice", () => {
  it.each([
    {
      name: "configured selected-agent foreground alias",
      sessionKey: "agent:work:primary",
      agentId: undefined,
      visible: false,
    },
    {
      name: "canonical selected-agent global foreground",
      sessionKey: "global",
      agentId: "work",
      visible: false,
    },
    {
      name: "canonical other-agent global background",
      sessionKey: "global",
      agentId: "other",
      visible: true,
    },
    {
      name: "genuine selected-agent background session",
      sessionKey: "agent:work:investigation",
      agentId: undefined,
      visible: true,
    },
    {
      name: "genuine other-agent configured-main session",
      sessionKey: "agent:other:primary",
      agentId: undefined,
      visible: true,
    },
  ])("configured-global observer notice: $name", async (testCase) => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    showCriticalSessionObserverNotice({
      payload: {
        sessionKey: testCase.sessionKey,
        agentId: testCase.agentId,
        headline: "Configured-global observer regression",
        health: "stuck",
        revision: 1,
      },
      selectedSessionKey: "global",
      sessionHost: {
        assistantAgentId: "work",
        agentsList: { defaultId: "work", mainKey: "primary", scope: "global" },
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "work",
              mainKey: "primary",
              mainSessionKey: "global",
            },
          },
        },
      },
      sessions: [
        { key: "global", label: "Global foreground", kind: "global", updatedAt: null },
        {
          key: "agent:work:investigation",
          label: "Selected-agent background",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:other:primary",
          label: "Other-agent configured main",
          kind: "direct",
          updatedAt: null,
        },
      ],
      tracker: new CriticalObserverNoticeTracker(),
      onOpen: vi.fn(),
    });

    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast") !== null).toBe(testCase.visible);
  });

  it("notices critical health only for a non-selected session", async () => {
    const onOpen = vi.fn();
    const tracker = new CriticalObserverNoticeTracker();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const show = (sessionKey: string, health: string, revision: number) =>
      showCriticalSessionObserverNotice({
        payload: { sessionKey, headline: "⚠️ Repeated test failure", health, revision },
        selectedSessionKey: "agent:main:selected",
        sessionHost: {},
        sessions: [
          { key: "agent:main:other", label: "Other work", kind: "direct", updatedAt: null },
        ],
        tracker,
        onOpen,
      });

    show("agent:main:selected", "waiting-on-user", 1);
    show("agent:main:other", "on-track", 1);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    show("agent:main:other", "stuck", 2);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — ⚠️ Repeated test failure",
    );

    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("agent:main:other");

    show("agent:main:other", "stuck", 3);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // Broad-only recipients miss recovery digests. A revision gap distinguishes
    // the next critical transition from an exact subscriber's repeat update.
    show("agent:main:other", "stuck", 5);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).not.toBeNull();
  });

  // Regression for #137125: a /clear (sessions.reset) replaces the observer
  // lifecycle, which restarts revisions at 1. Without retiring the pre-reset
  // revision floor, the new lifecycle's revision 1 is rejected as stale and the
  // critical notice is silently suppressed. Pre-fix: this test fails because
  // record(rev=1) after forget still consults the un-retired floor of 10.
  it.each([
    {
      name: "scoped session key",
      sessionKey: "agent:main:other",
      agentId: undefined,
    },
    {
      name: "global session key with agentId",
      sessionKey: "global",
      agentId: "work",
    },
  ])(
    "reset retires the revision floor so a new lifecycle revision 1 announces: $name",
    async ({ sessionKey, agentId }) => {
      const tracker = new CriticalObserverNoticeTracker();
      const toastHost = document.createElement("openclaw-toast-host");
      document.body.append(toastHost);
      const show = (revision: number) =>
        showCriticalSessionObserverNotice({
          payload: {
            sessionKey,
            agentId,
            headline: "Stuck after reset",
            health: "stuck",
            revision,
          },
          selectedSessionKey: "agent:main:selected",
          sessionHost: {},
          sessions: [{ key: sessionKey, label: "Reset target", kind: "direct", updatedAt: null }],
          tracker,
          onOpen: vi.fn(),
        });

      show(10);
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).not.toBeNull();

      toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast")).toBeNull();

      // /clear replaces the observer lifecycle; the UI retires the floor.
      tracker.forget({ sessionKey, agentId });

      show(1);
      await toastHost.updateComplete;
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
        "Reset target — Stuck after reset",
      );
    },
  );

  it("forget retires only the targeted session's revision floor", async () => {
    const tracker = new CriticalObserverNoticeTracker();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const show = (sessionKey: string, revision: number) =>
      showCriticalSessionObserverNotice({
        payload: {
          sessionKey,
          headline: "Stuck",
          health: "stuck",
          revision,
        },
        selectedSessionKey: "agent:main:selected",
        sessionHost: {},
        sessions: [
          { key: "agent:main:other", label: "Other", kind: "direct", updatedAt: null },
          { key: "agent:main:kept", label: "Kept", kind: "direct", updatedAt: null },
        ],
        tracker,
        onOpen: vi.fn(),
      });

    show("agent:main:other", 10);
    show("agent:main:kept", 10);
    await toastHost.updateComplete;
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Resetting only "other" must not clear "kept"'s floor: a same-or-lower
    // revision for "kept" is still deduplicated (no re-announcement).
    tracker.forget({ sessionKey: "agent:main:other" });

    show("agent:main:other", 1);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("Other — Stuck");

    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    show("agent:main:kept", 10);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();
  });

  it("forget is a no-op for a session with no prior floor", () => {
    const tracker = new CriticalObserverNoticeTracker();
    expect(() => tracker.forget({ sessionKey: "agent:main:absent" })).not.toThrow();
  });

  // After a reset, the new lifecycle's first digest (whatever revision it
  // starts at) must announce; once the floor is rebuilt, the normal dedup
  // loop resumes. This guards that forget does not break record's own dedup
  // cycle for same-lifecycle reconnect replays after the reset point.
  it("rebuilds the revision floor after forget and resumes dedup", async () => {
    const tracker = new CriticalObserverNoticeTracker();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const show = (revision: number) =>
      showCriticalSessionObserverNotice({
        payload: {
          sessionKey: "agent:main:other",
          headline: "Stuck",
          health: "stuck",
          revision,
        },
        selectedSessionKey: "agent:main:selected",
        sessionHost: {},
        sessions: [{ key: "agent:main:other", label: "Other", kind: "direct", updatedAt: null }],
        tracker,
        onOpen: vi.fn(),
      });

    show(10);
    await toastHost.updateComplete;
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // /clear retires the floor; the new lifecycle's first digest announces
    // even though its revision matches the pre-reset floor.
    tracker.forget({ sessionKey: "agent:main:other" });
    show(10);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("Other — Stuck");

    // The floor is rebuilt; a same-or-lower revision is deduplicated again.
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    show(10);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();
  });
});
