import { describe, expect, it } from "vitest";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";

function workSession(): SidebarRecentSession {
  return {
    attention: { kind: "none" },
    hasActiveRun: false,
    label: "Backing session",
    status: "done",
    subtitle: "~/Projects/openclaw",
    workSession: true,
  } as unknown as SidebarRecentSession;
}

describe("resolveSidebarSessionSubtitle", () => {
  it("shows tool progress in previews without displacing critical status", () => {
    const params = {
      session: { ...workSession(), hasActiveRun: true, activeRunIds: ["run-1"] },
      hasDisplay: false,
      displaySubtitle: undefined,
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLine: "Earlier assistant narration",
      toolActivity: { name: "exec", text: "Running focused tests" },
    };
    expect(resolveSidebarSessionSubtitle(params)).toEqual({
      subtitle: "Running focused tests",
      narration: undefined,
      toolName: "exec",
    });
    expect(resolveSidebarSessionSubtitle({ ...params, showPreview: false })).toEqual({
      subtitle: undefined,
      narration: undefined,
    });
    expect(
      resolveSidebarSessionSubtitle({
        ...params,
        observerDigest: {
          runId: "run-1",
          headline: "Needs a credential",
          health: "stuck",
          revision: 1,
          updatedAt: 2000,
        },
      }).subtitle,
    ).toBe("Needs a credential");
    expect(
      resolveSidebarSessionSubtitle({
        ...params,
        session: { ...params.session, attention: { kind: "question", requests: [] } },
      }).subtitle,
    ).toBeUndefined();
  });

  it.each(["waiting-on-user"] as const)(
    "keeps a %s observer headline when previews are hidden",
    (health) => {
      expect(
        resolveSidebarSessionSubtitle({
          session: {
            ...workSession(),
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
          },
          hasDisplay: false,
          sidebarLiveActivity: true,
          showPreview: false,
          narrationLine: "Using bash",
          observerDigest: {
            runId: "run-1",
            headline: "Blocked on a missing credential",
            health,
            updatedAt: 2_000,
            revision: 1,
          },
        }),
      ).toEqual({ subtitle: "Blocked on a missing credential", narration: undefined });
    },
  );

  it("keeps subtitle-owned attention and agent status ahead of the idle digest and last reply", () => {
    const session = {
      ...workSession(),
      lastMessagePreview: "The final reply is durable.",
      lastReadAt: 1_999,
      observerDigest: {
        headline: "Still implementing the repair",
        health: "done" as const,
        updatedAt: 2_000,
        revision: 2,
      },
    };
    const resolve = (overrides: Partial<SidebarRecentSession>) =>
      resolveSidebarSessionSubtitle({
        session: { ...session, ...overrides },
        hasDisplay: false,
        sidebarLiveActivity: true,
        showPreview: true,
        narrationLine: undefined,
        observerDigest: null,
      }).subtitle;

    expect(resolve({ agentStatusNote: "Waiting for deployment" })).toBe("Waiting for deployment");
    expect(
      resolve({
        attention: { kind: "question", requests: [] },
        agentStatusNote: "Waiting for deployment",
      }),
    ).toBeUndefined();
    expect(
      resolve({
        attention: { kind: "approval", requests: [] },
        agentStatusNote: "Waiting for deployment",
      }),
    ).toBe("Waiting for approval");
  });

  it("hides error details and ambient text when previews are hidden", () => {
    const hidden = (session: SidebarRecentSession, narrationLine?: string) =>
      resolveSidebarSessionSubtitle({
        session,
        hasDisplay: false,
        sidebarLiveActivity: true,
        showPreview: false,
        narrationLine,
        observerDigest: session.observerDigest ?? null,
      }).subtitle;

    expect(
      hidden({
        ...workSession(),
        attention: {
          kind: "error",
          reason: "⚠️ ✉️ Message failed: deployment unavailable",
          sourceSessionKey: "agent:main:deployment",
        },
        agentStatusNote: "Waiting for deployment",
        lastMessagePreview: "The final reply is durable.",
      }),
    ).toBeUndefined();

    expect([
      hidden({ ...workSession(), agentStatusNote: "Waiting for deployment" }),
      hidden({ ...workSession(), hasActiveRun: true }, "Using test runner"),
      hidden({
        ...workSession(),
        observerDigest: {
          headline: "Running checks",
          health: "done",
          updatedAt: 2_000,
          revision: 1,
        },
      }),
      hidden({ ...workSession(), lastMessagePreview: "The final reply is durable." }),
      hidden(workSession()),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("observer digest freshness reconciliation", () => {
  it("prefers the higher-revision digest regardless of source", async () => {
    const { pickFreshestObserverDigest } = await import("../lib/observer-digest.ts");
    const older = { revision: 4, updatedAt: 100, headline: "old" };
    const newer = { revision: 5, updatedAt: 50, headline: "new" };
    expect(pickFreshestObserverDigest(older, newer)?.headline).toBe("new");
    expect(pickFreshestObserverDigest(newer, older)?.headline).toBe("new");
    expect(pickFreshestObserverDigest(null, older)?.headline).toBe("old");
    expect(pickFreshestObserverDigest(older, null)?.headline).toBe("old");
    const tie = { revision: 5, updatedAt: 60, headline: "tie-newer" };
    expect(pickFreshestObserverDigest(newer, tie)?.headline).toBe("tie-newer");
  });
});
