import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHistoryHandler } from "./cron-history.js";
import { createReadService } from "./cron-read.test-support.js";
import { cronHandlers } from "./cron.js";
import { createCronCallerClient, createCronJob } from "./cron.validation.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const publication = vi.hoisted(() => ({
  afterVerification: () => {},
  verified: false,
}));
vi.mock("../../cron/store/read-only.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/store/read-only.js")>()),
  readCronRunHistoryBinding: async () => ({
    binding: "recorded-binding",
    agentId: "main",
    sessionKey: "agent:main:cron:cron-1:run:record",
    sessionId: "recorded-generation",
  }),
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
  { method: "cron.list", change: "off-page unchanged" },
  { method: "cron.list", change: "duplicate allowed first" },
  { method: "cron.list", change: "duplicate denied first" },
  { method: "cron.list", change: "client" },
  { method: "cron.list", change: "resident unavailable" },
  { method: "cron.list", change: "off-page grant" },
  { method: "cron.list", change: "off-page removal" },
  { method: "cron.list", change: "off-page retarget" },
  { method: "cron.list", change: "second selected removal" },
  { method: "cron.list", change: "second selected retarget" },
] as const)(
  "$method rechecks $change authority before final publication",
  async ({ method, change }) => {
    const cron = createReadService({
      storePath: "/synthetic/cron",
      cronEnabled: false,
      defaultAgentId: "main",
      enqueueSystemEvent() {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const job = createCronJob({
      agentId: "main",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const secondJob = createCronJob({ id: "cron-2", agentId: "main" });
    const selectedJobs =
      change === "second selected removal" || change === "second selected retarget"
        ? [job, secondJob]
        : [job];
    let residentJobs: Array<typeof job> | undefined = selectedJobs;
    vi.spyOn(cron, "readJob").mockResolvedValue(job);
    vi.spyOn(cron, "getJob").mockImplementation((id) =>
      residentJobs?.find((candidate) => candidate.id === id),
    );
    vi.spyOn(cron, "getLoadedJobs").mockImplementation(() => residentJobs);
    vi.spyOn(cron, "listPage").mockImplementation(async (_options, matchesJob) => {
      for (const selectedJob of selectedJobs) {
        expect(matchesJob?.(selectedJob)).toBe(true);
      }
      return {
        jobs: [],
        total: selectedJobs.length,
        offset: selectedJobs.length,
        limit: 1,
        hasMore: false,
        nextOffset: null,
        snapshotRevision: "fixture:off-page",
      };
    });
    const client = createCronCallerClient(
      "main",
      undefined,
      "agent:main:cron:cron-1:run:reader",
      job.id,
    );
    const claim = expectDefined(
      client.internal?.agentRuntimeIdentity?.cronSelfManagementContext,
      "self-management claim",
    );
    let current = true;
    publication.verified = false;
    publication.afterVerification = () => {
      if (change === "off-page unchanged") {
        return;
      }
      if (change === "client") {
        current = false;
      } else if (change === "off-page removal") {
        residentJobs = [];
      } else if (change === "off-page retarget") {
        residentJobs = [createCronJob({ ...job, agentId: "other" })];
      } else if (change === "second selected removal") {
        residentJobs = [job];
      } else if (change === "second selected retarget") {
        residentJobs = [job, createCronJob({ ...secondJob, agentId: "other" })];
      } else if (change === "resident unavailable") {
        residentJobs = undefined;
      } else if (change === "duplicate allowed first") {
        residentJobs = [job, createCronJob({ ...job, agentId: "other" })];
      } else if (change === "duplicate denied first") {
        residentJobs = [createCronJob({ ...job, agentId: "other" }), job];
      } else {
        claim.expiresAtMs = Date.now() - 1;
      }
    };
    const respond = vi.fn<RespondFn>();
    const params =
      method === "cron.history"
        ? { id: job.id, runId: "public" }
        : { offset: selectedJobs.length, limit: 1 };
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
      if (change === "off-page unchanged" || change === "duplicate allowed first") {
        await invocation;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({ jobs: [], total: 1, offset: 1, limit: 1 }),
          undefined,
        );
      } else if (method === "cron.list") {
        await expect(invocation).rejects.toThrow(
          change === "client" ? "Cron history authority closed" : "Cron list visibility changed",
        );
        expect(respond).not.toHaveBeenCalled();
      } else {
        await invocation;
        expect(respond.mock.calls).toMatchObject([[false, undefined, { code: "UNAVAILABLE" }]]);
      }
      expect(publication.verified).toBe(true);
    } finally {
      cron.stop();
    }
  },
);
