import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { InstantThreadHandoff } from "./instant-thread-handoff.ts";
import { restoredInstantThreadPage, takeInstantThreadRestore } from "./instant-thread-restore.ts";
import { createNewSessionRouteData } from "./location.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";

describe("retained page render ownership", () => {
  it.each(["loading", "restored"] as const)(
    "keeps retained page ownership while %s and rejects a changed principal",
    async (phase) => {
      const previousAgentId = "previous";
      const { context } = createDraftFixture();
      context.agentSelection.state.selectedId = previousAgentId;
      vi.mocked(context.agentSelection.set).mockImplementation((agentId) => {
        context.agentSelection.state.selectedId = agentId;
      });
      const data: NewSessionRouteData = createNewSessionRouteData();
      const page = document.createElement("div");
      page.textContent = "private incognito draft";
      let consumed: NewSessionRouteData | undefined;
      let releaseRoute!: () => void;
      const routeReady = new Promise<void>((resolve) => {
        releaseRoute = resolve;
      });
      const navigate: ApplicationContext["router"]["navigate"] = (
        routeId,
        _context,
        _options,
        location,
      ) => {
        if (routeId === "new-session") {
          consumed = takeInstantThreadRestore(context, location?.search ?? "");
        }
        return routeId === "new-session" ? routeReady : Promise.resolve();
      };
      Object.defineProperties(context, {
        basePath: { value: "" },
        router: {
          value: { getState: () => ({ location: undefined }), subscribe: () => () => {}, navigate },
        },
      });
      Object.defineProperty(context.gateway, "subscribe", { value: () => () => {} });
      const release = vi.fn();
      const handoff = new InstantThreadHandoff(
        context,
        "agent:main:dashboard:private",
        "main",
        {
          data,
          page,
          release,
          synchronizeGateway: vi.fn(),
        },
        null,
      );
      const rollback = handoff.rollback();
      try {
        await vi.waitFor(() => expect(consumed).toBe(data));
        expect(context.agentSelection.state.selectedId).toBe(previousAgentId);
        expect(restoredInstantThreadPage(consumed)).toBe(page);
        if (phase === "restored") {
          releaseRoute();
          await rollback;
          Object.assign(context.gateway.snapshot, { phase: "reconnecting" });
          expect(restoredInstantThreadPage(consumed)).toBe(page);
          Object.assign(context.gateway.snapshot, { phase: "connected" });
          expect(restoredInstantThreadPage(consumed)).toBe(page);
        }
        const auth = context.gateway.snapshot.hello?.auth;
        if (!auth) {
          throw new Error("fixture requires authenticated hello");
        }
        auth.recoveryScope = "replacement-principal";
        expect(restoredInstantThreadPage(consumed)).toBeUndefined();
      } finally {
        releaseRoute();
        await rollback;
      }
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
