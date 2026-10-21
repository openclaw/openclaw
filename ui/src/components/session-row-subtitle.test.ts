import { describe, expect, it } from "vitest";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  resolveSidebarSessionRowSubtitle,
  resolveSidebarSessionSubtitle,
} from "./session-row-subtitle.ts";

function workSession(overrides: Partial<SidebarRecentSession> = {}): SidebarRecentSession {
  return {
    attention: { kind: "none" },
    hasActiveRun: false,
    label: "Backing session",
    status: "done",
    subtitle: "~/Projects/openclaw",
    workSession: true,
    ...overrides,
  } as unknown as SidebarRecentSession;
}

function resolve(
  session = workSession(),
  options: Partial<Parameters<typeof resolveSidebarSessionSubtitle>[0]> = {},
) {
  return resolveSidebarSessionSubtitle({
    session,
    hasDisplay: false,
    sidebarLiveActivity: true,
    showPreview: true,
    narrationLine: undefined,
    ...options,
  });
}

function digest(
  headline: string,
  health: "stuck" | "waiting-on-user" | "done" = "done",
  runId?: string,
) {
  return { headline, health, revision: 1, updatedAt: 2_000, ...(runId ? { runId } : {}) };
}

describe("resolveSidebarSessionSubtitle", () => {
  it("shows tool progress in previews without displacing critical status", () => {
    const params = {
      session: workSession({ hasActiveRun: true, activeRunIds: ["run-1"] }),
      narrationLine: "Earlier assistant narration",
      toolActivity: { name: "exec", text: "Running focused tests" },
    };
    expect(resolve(params.session, params)).toEqual({
      subtitle: "Running focused tests",
      narration: undefined,
      toolName: "exec",
    });
    expect(resolve(params.session, { ...params, showPreview: false })).toEqual({
      subtitle: undefined,
      narration: undefined,
    });
    expect(
      resolve(params.session, {
        ...params,
        observerDigest: digest("Needs a credential", "stuck", "run-1"),
      }).subtitle,
    ).toBe("Needs a credential");
    expect(
      resolve(params.session, {
        ...params,
        session: { ...params.session, attention: { kind: "question", requests: [] } },
      }).subtitle,
    ).toBeUndefined();
  });

  it("keeps a waiting-on-user observer headline when previews are hidden", () => {
    expect(
      resolve(workSession({ hasActiveRun: true, activeRunIds: ["run-1"], status: "running" }), {
        showPreview: false,
        narrationLine: "Using bash",
        observerDigest: digest("Blocked on a missing credential", "waiting-on-user", "run-1"),
      }),
    ).toEqual({ subtitle: "Blocked on a missing credential", narration: undefined });
  });

  it("keeps subtitle-owned attention and agent status ahead of the idle digest and last reply", () => {
    const session = workSession({
      lastMessagePreview: "The final reply is durable.",
      lastReadAt: 1_999,
      observerDigest: { ...digest("Still implementing the repair"), revision: 2 },
    });
    const subtitle = (overrides: Partial<SidebarRecentSession>) =>
      resolve(
        { ...session, agentStatusNote: "Waiting for deployment", ...overrides },
        {
          observerDigest: null,
        },
      ).subtitle;

    expect([
      subtitle({}),
      subtitle({ attention: { kind: "question", requests: [] } }),
      subtitle({ attention: { kind: "approval", requests: [] } }),
    ]).toEqual(["Waiting for deployment", undefined, undefined]);
  });

  it("hides error details and ambient text when previews are hidden", () => {
    const hidden = (overrides: Partial<SidebarRecentSession> = {}, narrationLine?: string) =>
      resolve(workSession(overrides), {
        showPreview: false,
        narrationLine,
        observerDigest: overrides.observerDigest ?? null,
      }).subtitle;

    expect(
      hidden({
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
      hidden({ agentStatusNote: "Waiting for deployment" }),
      hidden({ hasActiveRun: true }, "Using test runner"),
      hidden({ observerDigest: digest("Running checks") }),
      hidden({ lastMessagePreview: "The final reply is durable." }),
      hidden(),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("resolveSidebarSessionRowSubtitle", () => {
  it("keeps preview-independent status lines to the agent-first roster", () => {
    const session = workSession({
      hasActiveRun: true,
      activeRunIds: ["run-1"],
      status: "running",
      attention: { kind: "agent", icon: "hourglass", note: "Unable to read the job snapshot" },
    });
    const stuck = workSession({
      ...session,
      attention: { kind: "none" },
      observerDigest: digest("Stuck on a missing credential", "stuck", "run-1"),
    });
    const subtitle = (
      row: SidebarRecentSession,
      sidebarAgentsMode: "chip" | "roster",
      sessionsShowPreview = false,
    ) =>
      resolveSidebarSessionRowSubtitle(
        {
          sidebarAgentsMode,
          sessionsShowPreview,
          sidebarLiveActivity: true,
          sidebarTools: new Map(),
          sessionProjection: { resolveSubtitle: resolveSidebarSessionSubtitle },
          sidebarNarrationLines: new Map(),
          sidebarObserverDigests: new Map(),
        },
        row,
      ).subtitle;

    expect([subtitle(session, "chip"), subtitle(stuck, "chip")]).toEqual([undefined, undefined]);
    expect([subtitle(session, "roster"), subtitle(stuck, "roster")]).toEqual([
      "Unable to read the job snapshot",
      "Stuck on a missing credential",
    ]);
    expect(subtitle(session, "chip", true)).toBe("Unable to read the job snapshot");
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
