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
  { method: "cron.list", change: "off-page grant" },
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
