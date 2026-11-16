import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { completeInitialSessionTurn } from "./initial-session-turn-handoff.ts";
import { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";
import * as rejected from "./rejected-initial-turn.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("first-turn publication", () => {
  it("retires an accepted draft before a slow preview route is ready", async () => {
    const { context } = createDraftFixture();
    let ready!: () => void;
    Object.defineProperty(context, "router", {
      value: {
        getState: () => ({ location: undefined }),
        subscribe: () => () => {},
        navigate: () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      },
    });
    const key = "agent:main:accepted-before-preview";
    const instant = new InstantThreadHandoff(
      context,
      key,
      "main",
      {
        data: createNewSessionRouteData(),
        page: document.createElement("div"),
        release: vi.fn(),
        synchronizeGateway: vi.fn(),
      },
      null,
    );
    const client = context.gateway.snapshot.client!;
    const clearDraft = vi.fn(async () => {});
    const navigation = new StartedSessionNavigation();
    vi.spyOn(navigation, "navigate").mockResolvedValue();
    const completion = completeInitialSessionTurn({
      context,
      client,
      agentId: "main",
      result: { key, initialRun: { status: "started", runId: "accepted-run" } },
      turn: { text: "Accepted prompt", attachments: [], createdAt: 1 },
      instant,
      navigation,
      isCurrent: () => true,
      clearDraft,
      completeInBackground: () => false,
      finishNavigation: vi.fn(),
    });
    try {
      // Acceptance, not lazy route readiness or storage completion, consumes input.
      expect(clearDraft).toHaveBeenCalledOnce();
      expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
    } finally {
      ready();
      await completion;
      instant.dispose();
    }
  });

  it.each([
    { status: "started", change: "scope" },
    { status: "rejected", change: "request" },
    { status: "started", change: "unchanged" },
    { status: "rejected", change: "unchanged" },
  ] as const)(
    "rechecks $change authority before publishing a $status turn",
    async ({ status, change }) => {
      const { context } = createDraftFixture();
      Object.defineProperties(context, {
        router: {
          value: {
            getState: () => ({ location: undefined }),
            subscribe: () => () => {},
            navigate: () => Promise.resolve(),
          },
        },
      });
      Object.defineProperty(context.gateway, "subscribe", { value: () => () => {} });
      const key = "agent:main:dashboard:incognito-private";
      const instant = new InstantThreadHandoff(
        context,
        key,
        "main",
        {
          data: createNewSessionRouteData(),
          page: document.createElement("div"),
          release: vi.fn(),
          synchronizeGateway: vi.fn(),
        },
        null,
      );
      try {
        // Settle preview readiness, then invalidate ownership in the microtask
        // between checking readiness and publishing the first-turn result.
        await instant.waitForReady();
        expect(instant.isCurrent()).toBe(true);
        const client = context.gateway.snapshot.client;
        const auth = context.gateway.snapshot.hello?.auth;
        if (!client || !auth) {
          throw new Error("fixture requires authenticated client");
        }
        const clearDraft = vi.fn(async () => {});
        const retainRejected = vi.spyOn(rejected, "retainRejectedInitialTurn");
        const navigation = new StartedSessionNavigation();
        const navigate = vi.spyOn(navigation, "navigate").mockResolvedValue();
        let current = true;
        const completion = completeInitialSessionTurn({
          context,
          client,
          agentId: "main",
          result: {
            key,
            initialRun:
              status === "started"
                ? { status, runId: "private-run" }
                : { status, error: "synthetic denial" },
          },
          turn: { text: "private incognito first turn", attachments: [], createdAt: 1 },
          instant,
          navigation,
          isCurrent: () => current,
          clearDraft,
          completeInBackground: () => false,
          finishNavigation: vi.fn(),
        });
        queueMicrotask(() => {
          if (change === "scope") {
            auth.recoveryScope = "replacement-principal";
          } else if (change === "request") {
            current = false;
          }
        });
        await completion;
        if (change === "unchanged") {
          expect(navigate).toHaveBeenCalledOnce();
          expect(clearDraft).toHaveBeenCalledOnce();
          if (status === "started") {
            expect(
              context.chatSubmissions.readInitial(key, client)?.message?.content,
            ).toContainEqual({
              type: "text",
              text: "private incognito first turn",
            });
          } else {
            expect(retainRejected).toHaveBeenCalledOnce();
          }
        } else {
          expect(navigate).not.toHaveBeenCalled();
          expect(context.chatSubmissions.readInitial(key, client)).toBeNull();
          expect(retainRejected).not.toHaveBeenCalled();
          expect(JSON.stringify(localStorage)).not.toContain("private incognito first turn");
          if (status === "started") {
            expect(clearDraft).toHaveBeenCalledWith(true, undefined);
          } else {
            expect(clearDraft).not.toHaveBeenCalled();
          }
        }
      } finally {
        instant.dispose();
      }
    },
  );
});
