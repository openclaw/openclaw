import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { cronRunLogEntryToDetail } from "../../cron/run-history-detail.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHistoryHandler } from "./cron-history.js";
import { cronHandlers } from "./cron.js";
import { createCronJob } from "./cron.validation.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const publication = vi.hoisted(() => ({
  afterVerification: () => {},
  verified: false,
}));
vi.mock("../../cron/store/read-only.js", () => ({
  readCronRunRecords: async () => [
    {
      id: "record",
      jobId: "cron-1",
      runId: "internal",
      createdAt: 1,
      endedAt: 2,
      status: "succeeded",
      agentId: "main",
      sessionKey: "agent:main:cron:cron-1:run:record",
      detail: cronRunLogEntryToDetail(
        {
          jobId: "cron-1",
          action: "finished",
          ts: 2,
          runAtMs: 1,
          runId: "public",
          sessionId: "recorded-generation",
          status: "ok",
        },
        { storeKey: "/synthetic/cron" },
      ),
    },
  ],
}));
vi.mock("../../config/sessions/session-history-worker-runtime.js", () => ({
  readSessionHistoryPageInWorker: async () => ({ sessionKey: "agent:main:cron:cron-1" }),
}));
vi.mock("./chat-history-handler.js", () => ({
  handleChatHistoryRequest: async (opts: {
    retainedTranscript: { verifyRetainedState: () => Promise<boolean> };
    respond: RespondFn;
  }) => {
    publication.verified = await opts.retainedTranscript.verifyRetainedState();
    publication.afterVerification();
    opts.respond(true, { messages: [{ role: "assistant", content: "private" }] });
  },
}));
vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryPreview: async () => ({}),
  resolveCronDeliveryPreviews: async ({ jobs }: { jobs: unknown[] }) => {
    expect(jobs).toEqual([]);
    publication.verified = true;
    publication.afterVerification();
    return {};
  },
}));

it.each([
  { method: "cron.history", change: "client" },
  { method: "cron.history", change: "grant" },
  { method: "cron.list", change: "off-page grant" },
] as const)(
  "$method rechecks $change authority before final publication",
  async ({ method, change }) => {
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath: "/synthetic/cron",
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const job = createCronJob({
      agentId: "main",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    vi.spyOn(cron, "readJob").mockResolvedValue(job);
    vi.spyOn(cron, "getJob").mockReturnValue(job);
    vi.spyOn(cron, "listPage").mockImplementation(async (_options, matchesJob) => {
      expect(matchesJob?.(job)).toBe(true);
      return {
        jobs: [],
        total: 1,
        offset: 1,
        limit: 1,
        hasMore: false,
        nextOffset: null,
        snapshotRevision: "fixture:off-page",
      };
    });
    const instance = createOperationalRunInstanceRef("publication-run");
    const claim = { jobId: job.id, expiresAtMs: Date.now() + 60_000 };
    const client: GatewayClient = {
      connect: {} as GatewayClient["connect"],
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:cron:cron-1:run:reader",
          operationalRunInstance: instance,
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: instance,
            lifecycleGeneration: "fixture",
            claimId: "fixture",
          },
          cronSelfManagementContext: claim,
        },
      },
    };
    let current = true;
    publication.verified = false;
    publication.afterVerification = () => {
      if (change === "client") {
        current = false;
      } else {
        claim.expiresAtMs = Date.now() - 1;
      }
    };
    const respond = vi.fn<RespondFn>();
    const params =
      method === "cron.history" ? { id: job.id, runId: "public" } : { offset: 1, limit: 1 };
    try {
      const invocation = expectDefined(
        method === "cron.history" ? cronHistoryHandler : cronHandlers[method],
        "Cron read handler",
      )({
        req: { type: "req", id: "history", method, params },
        params,
        client,
        respond,
        context: createDirectChatContext({
          cron,
          cronStorePath: "/synthetic/cron",
          getRuntimeConfig: () => ({}),
        }),
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      });
      if (method === "cron.list") {
        await expect(invocation).rejects.toThrow("Cron list visibility changed");
        expect(respond).not.toHaveBeenCalled();
        expect(publication.verified).toBe(true);
        return;
      }
      await invocation;
      expect(publication.verified).toBe(true);
      expect(respond.mock.calls).toHaveLength(1);
      expect(respond.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
    } finally {
      cron.stop();
      vi.restoreAllMocks();
    }
  },
);
