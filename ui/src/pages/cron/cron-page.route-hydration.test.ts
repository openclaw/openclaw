import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult, CronJob, CronJobsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createInitialCronState, loadCronJobsPage } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("automation route hydration", () => {
  it.each([false, true])(
    "does not retain another scope's inventory after refresh failure (loaded=%s)",
    async (loaded) => {
      const earlier = createDeferred<CronJobsListResult>();
      const current = createDeferred<CronJobsListResult>();
      const currentRequested = createDeferred();
      let reads = 0;
      const client = createTestGatewayClient(() => {
        if (++reads === 1) {
          return earlier.promise;
        }
        currentRequested.resolve();
        return current.promise;
      });
      const state = createInitialCronState({ client, connected: true });
      const loading = loadCronJobsPage(state);
      let refreshing: Promise<void> | undefined;
      const olderPage = cronListResponse([
        createCronViewJob("other-agent-job", { agentId: "other" }),
      ]);
      try {
        if (loaded) {
          earlier.resolve(olderPage);
          await loading;
        }
        state.cronAgentId = "main";
        refreshing = loadCronJobsPage(state);
        earlier.resolve(olderPage);
        await currentRequested.promise;
        expect(state.cronJobs).toEqual([]);
        current.reject(new Error("Current scope unavailable"));
        await Promise.all([loading, refreshing]);
        expect(state.cronJobs).toEqual([]);
        expect(state.cronJobsError).toBe("Current scope unavailable");
      } finally {
        earlier.resolve(cronListResponse([]));
        current.resolve(cronListResponse([]));
        await Promise.all([loading, refreshing]);
      }
    },
  );

  it.each([
    "hello",
    "roster",
    "roster after editing",
    "roster after same-scope intent",
    "roster after model catalog",
  ])(
    "opens the linked editor when %s supplies the initial agent scope after mount",
    async (publication) => {
      const job = createCronViewJob("linked-job", { name: "Linked automation" });
      const roster = createDeferred<AgentsListResult>();
      const lookup = createDeferred<CronJob>();
      const fallback = createRequest();
      const changingCatalog = publication === "roster after model catalog";
      const client = createTestGatewayClient((method, params) => {
        if (method === "agents.list") {
          return roster.promise;
        }
        if (method === "cron.get") {
          return lookup.promise;
        }
        if (method === "models.list" && changingCatalog) {
          if (asOptionalRecord(params)?.agentId === "previous") {
            return { models: [{ id: "previous-model" }] };
          }
          throw new Error("Current agent catalog unavailable");
        }
        return fallback(method);
      });
      const gateway = createGateway(client, false);
      const agents = createAgentCapability(gateway);
      const agentSelection = createAgentSelectionCapability(gateway, agents);
      const page = createPage(
        { ...createContext(gateway), agents, agentSelection },
        { render: true },
      );
      page.routeSearch = `?job=${job.id}`;
      const agentList: AgentsListResult = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      };
      const edited =
        publication === "roster after editing" ||
        publication === "roster after same-scope intent" ||
        changingCatalog;
      try {
        // Warm reload mounts the route before either authoritative default arrives.
        await page.updateComplete;
        expect(agentSelection.state.scopeId).toBeNull();
        gateway.emitSnapshot({
          phase: "connected",
          assistantAgentId: changingCatalog ? "previous" : publication === "hello" ? "main" : null,
        });
        await page.updateComplete;
        if (changingCatalog) {
          await waitForCronPage(() =>
            expect(page.cronModelSuggestions).toEqual(["previous-model"]),
          );
        }
        if (edited) {
          lookup.resolve(job);
          await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
          const name = page.querySelector<HTMLInputElement>("#cron-name")!;
          name.value = "Unsaved name";
          name.dispatchEvent(new Event("input", { bubbles: true }));
          await page.updateComplete;
          if (publication === "roster after same-scope intent") {
            agentSelection.setScope(null);
          }
        }
        roster.resolve(agentList);
        await agents.ensureList();
        expect(agentSelection.state.scopeId).toBe("main");
        lookup.resolve(job);

        if (changingCatalog) {
          await waitForCronPage(() =>
            expect(page.textContent).toContain("Current agent catalog unavailable"),
          );
          expect(page.cronModelSuggestions).toEqual([]);
        }

        await waitForCronPage(() => {
          expect(page.querySelector(".cron-detail-title")?.textContent ?? "").toContain(job.name);
          expect(page.querySelector("details.cron-advanced > summary")).not.toBeNull();
          expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
            edited ? "Unsaved name" : job.name,
          );
        });
      } finally {
        page.remove();
        agentSelection.dispose();
        agents.dispose();
        roster.resolve(agentList);
        lookup.resolve(job);
      }
    },
  );
});
