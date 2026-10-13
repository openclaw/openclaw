import { expect, it, vi } from "vitest";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoComputeTarget } from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { readSessionTranscriptIndexStatus } from "../config/sessions/session-transcript-projection-writer.js";
import {
  prepareReconcileParams,
  readSessionTranscriptProjectionStatus,
} from "../config/sessions/session-transcript-reconcile-readiness.js";
import { refreshCostUsageCacheForAgent } from "../infra/session-cost-usage-aggregation.js";
import { loadSessionCostSummariesFromCache } from "../infra/session-cost-usage-cache-runtime.js";
import { isSessionCostUsageRefreshRunning } from "../infra/session-cost-usage-cache.sqlite.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import * as usagePricing from "../infra/session-cost-usage-pricing-context.js";
import {
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../infra/session-cost-usage-reporting.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../infra/session-cost-usage-worker-runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";

type ComputeWiringFixture = {
  readonly actor: IncognitoAgentDatabaseExecution;
  readonly env: NodeJS.ProcessEnv;
  authority: IncognitoSessionAuthority;
  create(this: void, sessionId: string): Promise<IncognitoComputeTarget>;
  append(
    this: void,
    target: IncognitoComputeTarget,
    content: string,
    owner?: IncognitoAgentDatabaseExecution,
    parentId?: string | null,
  ): Promise<unknown>;
  branch(this: void, target: IncognitoComputeTarget): Promise<IncognitoComputeTarget>;
  marker(this: void, target: IncognitoComputeTarget): string;
};

export function registerIncognitoComputeWiringTests(fixture: ComputeWiringFixture) {
  const { authority, create, append, branch, marker } = fixture;

  it.each([
    "index-caller",
    "index-signal",
    "projection",
    "refresh-status",
    "inventory",
    "inventory-generation",
    "inventory-rewrite",
  ] as const)("rejects %s disclosure revoked before compute returns", async (kind) => {
    const { actor, env } = fixture;
    const target = await create(`compute-disclosure-${kind}`);
    const cancelled = new AbortController();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("compute disclosure revoked");
      }
    };
    const original = actor.sessions.withCompute;
    const settled = vi
      .spyOn(actor.sessions, "withCompute")
      .mockImplementation((grant, selected, operation, signal, onRead) =>
        original(grant, selected, operation, signal, onRead).then(async (result) => {
          if (kind === "inventory-generation") {
            await branch(target);
          } else if (kind === "inventory-rewrite") {
            await append(target, "new transcript content", actor, null);
          } else {
            current = false;
            cancelled.abort(new Error("compute disclosure revoked"));
          }
          return result;
        }),
      );
    try {
      const database = { agentId: actor.agentId, path: actor.path, env };
      await expect(
        withIncognitoSessionActor(
          actor,
          async () => {
            switch (kind) {
              case "index-caller":
                return readSessionTranscriptIndexStatus(database, assertCurrent);
              case "index-signal":
                return readSessionTranscriptIndexStatus(database);
              case "projection":
                return readSessionTranscriptProjectionStatus(
                  prepareReconcileParams(database),
                  target.sessionId,
                );
              case "refresh-status":
                return isSessionCostUsageRefreshRunning(actor.agentId, actor.path);
              default:
                return runUsageCostWorker(
                  prepareUsageCostWorker({ agentId: actor.agentId, storePath: actor.path, env }),
                  {
                    kind: "inventory",
                    sessionFiles: [marker(target)],
                  },
                );
            }
          },
          kind === "index-caller" ? undefined : cancelled.signal,
        ),
      ).rejects.toThrow(
        kind === "inventory-generation"
          ? "generation is no longer current"
          : kind === "inventory-rewrite"
            ? "snapshot changed"
            : "compute disclosure revoked",
      );
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      settled.mockRestore();
    }
  });

  it("composes actor usage reports while retaining the durable cache owner", () =>
    withIncognitoSessionActor(fixture.actor, async () => {
      const { actor, env } = fixture;
      const target = await create("usage-facades");
      await append(target, "old branch");
      await append(target, "current usage", actor, null);
      const params = { agentId: "main", sessionFile: marker(target) };
      const published: unknown[] = [];
      const unsubscribe = onSessionCostUsageUpdated((event) => published.push(event));
      try {
        await withEnvAsync(env, async () => {
          expect(await loadSessionCostSummary(params)).toMatchObject({
            totalTokens: 10,
            totalCost: 1,
          });
          expect(await loadSessionUsageTimeSeries(params)).toMatchObject({
            points: [{ totalTokens: 10, cost: 1, cumulativeTokens: 10 }],
          });
          expect(await loadSessionLogs(params)).toMatchObject([
            { content: "current usage", tokens: 10, cost: 1 },
          ]);
          expect(
            await loadSessionCostSummariesFromCache({
              agentId: "main",
              sessions: [{ sessionFile: marker(target) }],
              requestRefresh: false,
            }),
          ).toMatchObject({ summaries: [{ totalTokens: 10, totalCost: 1 }] });
          expect(published).toHaveLength(1);
          expect(
            await refreshCostUsageCacheForAgent({
              agentId: "main",
              sessionFiles: [marker(target)],
            }),
          ).toBe("refreshed");
          expect(published).toHaveLength(1);
          // The facade's default cache remains durable; the actor stores only the transcript.
          await actor.sessions.withCompute(authority, target, async (compute) => {
            expect(
              await compute.execute({
                type: "session.compute.usage.cache",
                input: { ...target, request: { filePaths: [marker(target)] } },
              }),
            ).toEqual([]);
          });
        });
      } finally {
        unsubscribe();
      }
    }));

  it.each([
    ["logs", "permission", loadSessionLogs],
    ["logs", "generation", loadSessionLogs],
    ["logs", "admission", loadSessionLogs],
    ["timeseries", "permission", loadSessionUsageTimeSeries],
    ["timeseries", "generation", loadSessionUsageTimeSeries],
    ["timeseries", "admission", loadSessionUsageTimeSeries],
  ] as const)(
    "rechecks usage %s %s disclosure after asynchronous pricing",
    async (name, revoke, read) => {
      const { actor } = fixture;
      const target = await create(`usage-disclosure-${name}-${revoke}`);
      await append(target, "private usage");
      let allowed = true;
      const cancelled = new AbortController();
      const grant: IncognitoSessionAuthority = {
        assertCurrent() {},
        authorize() {
          if (!allowed) {
            throw new Error("usage disclosure revoked");
          }
        },
      };
      const parse = usagePricing.parseUsageCostTranscriptEntryAsync;
      let parsed = false;
      const parsing = vi
        .spyOn(usagePricing, "parseUsageCostTranscriptEntryAsync")
        .mockImplementation(async (...args) => {
          const entry = await parse(...args);
          if (entry?.usage && !parsed) {
            parsed = true;
            if (revoke === "permission") {
              allowed = false;
            } else if (revoke === "admission") {
              cancelled.abort(new Error("usage disclosure revoked"));
            } else {
              await branch(target);
            }
          }
          return entry;
        });
      try {
        await expect(
          revoke === "permission"
            ? read({
                agentId: "main",
                sessionFile: marker(target),
                incognito: { actor, authority: grant, target },
              })
            : withIncognitoSessionActor(
                actor,
                async () => read({ agentId: "main", sessionFile: marker(target) }),
                cancelled.signal,
              ),
        ).rejects.toThrow(
          revoke === "generation" ? "generation is no longer current" : "usage disclosure revoked",
        );
        expect(parsed).toBe(true);
      } finally {
        parsing.mockRestore();
      }
    },
  );
}
