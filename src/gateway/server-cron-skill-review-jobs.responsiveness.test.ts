import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as harnessAvailability from "../agents/harness/availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "../cron/skill-collection-review-monitor.js";
import * as providerRuntime from "../plugins/providers.runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";
import { AUTH_NONE, createTestGatewayServer } from "./server-http.test-harness.js";

const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: {
      blocked: {
        model: "openai/blocked-model",
        models: { "openai/blocked-model": { agentRuntime: { id: "codex" } } },
      },
      first: { model: "anthropic/claude-sonnet-4-6" },
      second: { model: "anthropic/claude-sonnet-4-6" },
    },
  },
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

it("projects monitor eligibility without entering provider load planning", () => {
  const planning = vi
    .spyOn(providerRuntime, "isPluginProvidersLoadInFlight")
    .mockImplementation(() => {
      throw new Error("monitor projection entered provider load planning");
    });
  try {
    expect(
      Array.from(resolveSkillCollectionReviewMonitorSpecs(cfg, []), ({ agentId, input }) => [
        agentId,
        input.enabled,
      ]),
    ).toEqual([
      ["blocked", false],
      ["first", true],
      ["second", true],
    ]);
    expect(planning).not.toHaveBeenCalled();
  } finally {
    planning.mockRestore();
  }
});

describe("skill review reconciliation responsiveness", () => {
  it("serves health and commits an agent before projecting the remaining fleet", async () => {
    const state = await createOpenClawTestState({ label: "review-projection-responsiveness" });
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: state.statePath("cron", "jobs.json"),
      cronEnabled: false,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const server = createTestGatewayServer({ resolvedAuth: AUTH_NONE });
    const projected = new Set<string | undefined>();
    const resolvePolicy = harnessAvailability.resolveAvailableAgentHarnessPolicy;
    const projection = vi
      .spyOn(harnessAvailability, "resolveAvailableAgentHarnessPolicy")
      .mockImplementation((params) => {
        projected.add(params.agentId);
        return resolvePolicy(params);
      });
    const committed = createDeferred();
    const release = createDeferred();
    const add = cron.add.bind(cron);
    const delayedAdd = vi.spyOn(cron, "add").mockImplementation(async (...args) => {
      const result = await add(...args);
      if (args[0].agentId === "blocked") {
        committed.resolve();
        await release.promise;
      }
      return result;
    });
    let reconciliation: Promise<unknown> | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("health listener did not bind a port");
      }
      reconciliation = reconcileSkillCollectionReviewJobs({ cron, cfg, logger });
      await committed.promise;
      expect(projected).toEqual(new Set(["blocked"]));
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "live" });
      expect((await cron.list({ includeDisabled: true })).map(({ agentId }) => agentId)).toEqual([
        "blocked",
      ]);
      release.resolve();
      await expect(reconciliation).resolves.toEqual({ ok: true });
      expect(
        (await cron.list({ includeDisabled: true }))
          .toSorted((left, right) => left.name.localeCompare(right.name))
          .map(({ agentId, enabled }) => [agentId, enabled]),
      ).toEqual([
        ["blocked", false],
        ["first", true],
        ["second", true],
      ]);
    } finally {
      release.resolve();
      await reconciliation;
      delayedAdd.mockRestore();
      projection.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      cron.stop();
      await state.cleanup();
    }
  });
});
