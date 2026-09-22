/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGatewayHarness, mountSidebar, TWO_AGENTS } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import "./app-sidebar.ts";

describe("AppSidebar automatic list scope replacement", () => {
  it("loads the selected filtered roster after an earlier automatic scope read settles", async () => {
    vi.useFakeTimers();
    const previous = deferred<ReturnType<typeof sessionsResult>>();
    const targets: unknown[] = [];
    let mainReads = 0;
    const archived = (agentId: string, label: string) =>
      sessionsResult(
        [{ key: `agent:${agentId}:archived`, kind: "direct", archived: true, label }],
        1,
      );
    const gateway = createGatewayHarness(
      createTestGatewayClient(async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          return {};
        }
        if (params?.archived !== true) {
          return sessionsResult([], 0);
        }
        targets.push(params.agentId);
        if (params.agentId === "research") {
          return previous.promise;
        }
        return archived("main", `Main archived ${++mainReads}`);
      }),
    );
    const sessions = createTestSessionCapability(gateway.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, context, provider } = await mountSidebar(
      gateway.gateway,
      sessions,
      "panel",
      TWO_AGENTS,
    );
    try {
      sidebar.connected = true;
      await sidebar.updateComplete;
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Main archived 1");

      context.agentSelection.set("research");
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      expect(targets).toEqual(["main", "research"]);
      context.agentSelection.set("main");
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      previous.resolve(archived("research", "Stale Research archived"));
      await vi.advanceTimersByTimeAsync(50);
      await sidebar.updateComplete;

      expect(sidebar.textContent).not.toContain("Stale Research archived");
      expect(targets).toEqual(["main", "research", "main"]);
      expect(sidebar.textContent).toContain("Main archived 2");
    } finally {
      previous.resolve(sessionsResult([], 0));
      provider.remove();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["research", "main"])(
    "loads the next active parent's children when its agent is %s",
    async (nextAgent) => {
      vi.useFakeTimers();
      const mainParent = "agent:main:parent";
      const researchParent = `agent:${nextAgent}:next-parent`;
      const mainChild = "agent:main:child";
      const researchChild = `agent:${nextAgent}:next-child`;
      const rows: GatewaySessionRow[] = [
        { key: mainParent, kind: "direct", label: "Main parent", childSessions: [mainChild] },
        {
          key: researchParent,
          kind: "direct",
          label: "Next parent",
          childSessions: [researchChild],
        },
        { key: mainChild, kind: "direct", label: "Stale Main child", spawnedBy: mainParent },
        { key: researchChild, kind: "direct", label: "Next child", spawnedBy: researchParent },
      ];
      const previous = deferred<ReturnType<typeof sessionsResult>>();
      const parents: unknown[] = [];
      let primaryReads = 0;
      const gateway = createGatewayHarness(
        createTestGatewayClient(async (method, raw) => {
          const params = asOptionalRecord(raw);
          if (method === "sessions.subscribe") {
            return { subscribed: true };
          }
          if (method === "sessions.describe") {
            return { session: rows.find((row) => row.key === params?.key) ?? null };
          }
          if (method !== "sessions.list") {
            return {};
          }
          if (params?.spawnedBy) {
            parents.push(params.spawnedBy);
            return params.spawnedBy === mainParent
              ? previous.promise
              : sessionsResult(
                  rows.filter((row) => row.spawnedBy === params.spawnedBy),
                  2,
                );
          }
          primaryReads += 1;
          const knownParents =
            nextAgent === "main"
              ? [mainParent, researchParent]
              : [params?.agentId === "research" ? researchParent : mainParent];
          return sessionsResult(
            rows.filter((row) => knownParents.includes(row.key)),
            1,
          );
        }),
      );
      const sessions = createTestSessionCapability(gateway.gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, context, provider } = await mountSidebar(
        gateway.gateway,
        sessions,
        "panel",
        TWO_AGENTS,
      );
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = mainParent;
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(50);
        expect(parents).toEqual([mainParent]);

        context.agentSelection.set(nextAgent);
        sidebar.sessionKey = researchParent;
        if (nextAgent !== "main") {
          await sessions.refresh({ agentId: nextAgent, force: true });
        }
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(50);
        expect(primaryReads).toBe(nextAgent === "main" ? 1 : 2);
        previous.resolve(
          sessionsResult(
            rows.filter((row) => row.key === mainChild),
            1,
          ),
        );
        await vi.advanceTimersByTimeAsync(50);
        await sidebar.updateComplete;

        if (nextAgent !== "main") {
          expect(sidebar.textContent).not.toContain("Stale Main child");
        }
        expect(parents).toEqual([mainParent, researchParent]);
        const expand = sidebar.querySelector<HTMLButtonElement>(
          `[data-child-session-toggle="${researchParent}"]`,
        );
        expect(expand).not.toBeNull();
        expect(expand?.getAttribute("aria-expanded")).toBe("false");
        expand!.click();
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        expect(sidebar.textContent).toContain("Next child");
        expect(parents).toEqual([mainParent, researchParent]);
      } finally {
        previous.resolve(sessionsResult([], 0));
        provider.remove();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
