import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { completeInitialSessionTurn } from "./initial-session-turn-handoff.ts";
import { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import * as rejected from "./rejected-initial-turn.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe.each(["started", "rejected"] as const)("%s first-turn publication", (status) => {
  it.each(["scope", "request", "unchanged"] as const)(
    "rechecks %s authority at the readiness publication boundary",
    async (change) => {
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
          data: {
            agentId: "main",
            requestedAgentId: "main",
            catalogId: "",
            model: "",
            catalogLabel: "",
            startTerminal: false,
          },
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
              context.chatSubmissions.readInitial(key, client)?.message.content,
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
            expect(clearDraft).toHaveBeenCalledWith(true, false);
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
