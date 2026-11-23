import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import * as cronPreviews from "../cron/delivery-preview.js";
import { loadCostUsageSummary } from "../infra/session-cost-usage.js";
import type { SessionsUsageResult } from "../shared/usage-types.js";
import { ExecApprovalExpiry } from "./exec-approval-expiry.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as usageReports from "./server-methods/usage-overview-report.js";

it("filters usage, cron and approval responses after invited membership is removed", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ state, sender, invited, carol, model, events }) => {
      const { key } = await sender.request<{ key: string }>(
        "sessions.create",
        {
          agentId: "main",
          visibility: "shared",
        },
        { signal },
      );
      const scope = { agentId: "main", sessionKey: key };
      const sessionId = loadSessionEntry(scope)!.sessionId;
      const timestamp = Date.now();
      await persistSessionTranscriptTurn(
        { ...scope, sessionId },
        {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              now: timestamp,
              message: {
                role: "assistant",
                content: "Synthetic usage",
                timestamp,
                provider: model.providerId,
                model: model.modelId,
                usage: { input: 17, output: 0, totalTokens: 17, cost: { total: 0 } },
              },
            },
          ],
        },
      );
      await loadCostUsageSummary({
        config: loadConfig(),
        agentId: "main",
        startMs: 0,
        endMs: timestamp + 1,
      });
      const membership = (method: "add" | "remove") =>
        sender.request(`session.members.${method}`, { ...scope, identityId: carol.id }, { signal });
      const usage = (offset = 0) =>
        invited.request<SessionsUsageResult>(
          "sessions.usage",
          {
            agentId: "main",
            range: "all",
            projection: "overview",
            offset,
          },
          { signal },
        );
      expect((await usage()).totals.totalTokens).toBe(0);
      await membership("add");
      const allowed = await usage();
      expect(allowed.sessions.map(({ key: sessionKey }) => sessionKey)).toContain(key);
      expect(allowed.totals.totalTokens).toBe(17);
      expect(allowed.aggregates.sessionCount).toBe(1);
      const usageEntered = createDeferred();
      const usageRelease = createDeferred();
      const createReporter = usageReports.createUsageOverviewReporter;
      using cleanup = new DisposableStack();
      cleanup.use(
        vi.spyOn(usageReports, "createUsageOverviewReporter").mockImplementation((params) => {
          const reporter = createReporter(params);
          let count = 0;
          return (
            reporter && {
              ...reporter,
              async run(rows) {
                const result = await reporter.run(rows);
                if (++count === 2) {
                  usageEntered.resolve();
                  await usageRelease.promise;
                }
                return result;
              },
            }
          );
        }),
      );
      const pendingUsage = usage(10);
      void pendingUsage.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            usageEntered.promise,
            pendingUsage,
            "usage skipped final overview aggregation",
          ),
          signal,
        );
        await membership("remove");
        usageRelease.resolve();
        const result = await pendingUsage;
        expect(result.sessions).toEqual([]);
        expect(result.totals.totalTokens).toBe(0);
        expect(result.aggregates.sessionCount).toBe(0);
        expect(result.overview).toMatchObject({ total: 0, unfilteredSessionCount: 0 });
      } finally {
        usageRelease.resolve();
        await Promise.allSettled([pendingUsage]);
      }

      const job = await sender.request<{ id: string }>(
        "cron.add",
        {
          agentId: "main",
          name: "Invited cron",
          enabled: false,
          sessionTarget: `session:${key}`,
          wakeMode: "next-heartbeat",
          schedule: { kind: "every", everyMs: 3_600_000 },
          payload: { kind: "agentTurn", message: "Private fixture", model: model.modelRef },
          delivery: { mode: "none" },
        },
        { signal },
      );
      const cron = () =>
        invited.request<{ jobs: { id: string }[]; total: number }>(
          "cron.list",
          {
            agentId: "main",
            includeDisabled: true,
            limit: 200,
          },
          { signal },
        );
      expect(await cron()).toMatchObject({ jobs: [], total: 0 });
      await membership("add");
      expect(await cron()).toMatchObject({
        jobs: [expect.objectContaining({ id: job.id })],
        total: 1,
      });
      const cronEntered = createDeferred();
      const cronRelease = createDeferred();
      const previews = cronPreviews.resolveCronDeliveryPreviews;
      cleanup.use(
        vi
          .spyOn(cronPreviews, "resolveCronDeliveryPreviews")
          .mockImplementationOnce(async (params) => {
            const result = await previews(params);
            cronEntered.resolve();
            await cronRelease.promise;
            return result;
          }),
      );
      const pendingCron = cron();
      void pendingCron.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            cronEntered.promise,
            pendingCron,
            "cron skipped delivery preparation",
          ),
          signal,
        );
        await membership("remove");
        cronRelease.resolve();
        await expect(pendingCron).rejects.toThrow(/visibility changed/i);
      } finally {
        cronRelease.resolve();
        await Promise.allSettled([pendingCron]);
      }
      expect(await cron()).toMatchObject({ jobs: [], total: 0 });
      await sender.request("cron.remove", { id: job.id }, { signal });

      await membership("add");
      const approval = (id: string) =>
        invited.request(
          "exec.approval.request",
          {
            id,
            command: "printf guest-proof",
            host: "gateway",
            ...scope,
            twoPhase: true,
            timeoutMs: 60_000,
            requireDeliveryRoute: false,
          },
          { signal },
        );
      const resolvedEvent = (id: string) =>
        events.invited.some(
          ({ event, payload }) =>
            event === "exec.approval.resolved" && isRecord(payload) && payload.id === id,
        );
      await approval("invited-positive");
      expect(
        await invited.request("exec.approval.get", { id: "invited-positive" }, { signal }),
      ).toMatchObject({ id: "invited-positive" });
      expect(await invited.request("exec.approval.list", {}, { signal })).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "invited-positive" })]),
      );
      await sender.request(
        "exec.approval.resolve",
        { id: "invited-positive", decision: "deny" },
        { signal },
      );
      await expect.poll(() => resolvedEvent("invited-positive")).toBe(true);

      await approval("invited-revoked");
      const approvalEntered = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- call preserves the intercepted expiry owner.
      const awaitDecision = ExecApprovalExpiry.prototype.awaitDecision;
      cleanup.use(
        vi.spyOn(ExecApprovalExpiry.prototype, "awaitDecision").mockImplementation(function (
          this: ExecApprovalExpiry<unknown>,
          id,
        ) {
          const result = awaitDecision.call(this, id);
          if (id === "invited-revoked") {
            approvalEntered.resolve();
          }
          return result;
        }),
      );
      const pendingDecision = invited.request(
        "exec.approval.waitDecision",
        { id: "invited-revoked" },
        { signal },
      );
      void pendingDecision.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(
          approvalEntered.promise,
          pendingDecision,
          "approval skipped its retained decision waiter",
        ),
        signal,
      );
      await membership("remove");
      await expect(
        invited.request("exec.approval.get", { id: "invited-revoked" }, { signal }),
      ).rejects.toThrow();
      expect(await invited.request("exec.approval.list", {}, { signal })).toEqual([]);
      await sender.request(
        "exec.approval.resolve",
        { id: "invited-revoked", decision: "deny" },
        { signal },
      );
      await expect(pendingDecision).rejects.toThrow();
      await invited.request("health", {}, { signal });
      expect(resolvedEvent("invited-revoked")).toBe(false);

      for (const [method, params] of [
        ["usage.cost", { agentId: "main" }],
        ["transcripts.list", { agentId: "main", limit: 10 }],
        ["transcripts.status", {}],
      ] as const) {
        await expect(invited.request(method, params, { signal })).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await expect(sender.request(method, params, { signal })).resolves.toBeDefined();
      }
    },
  );
});
