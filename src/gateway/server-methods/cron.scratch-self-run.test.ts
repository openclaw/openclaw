import { expect, it, vi } from "vitest";
import type { CronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import { createCronStoreHarness } from "../../cron/service.test-harness.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createHistoryJob, createReadService } from "./cron-read.test-support.js";
import { cronHandlers } from "./cron.js";
import {
  cronAccountPolicy,
  createCronCallerClient as callerClient,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-scratch-self-run-" });
const getRuntimeConfig = () => ({});
const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

const OWNER = {
  agentId: "ops",
  sessionKey: "agent:ops:telegram:group:OWNER",
  accountId: "default",
};
const TRUSTED: CronScheduledToolPolicy = { version: 1, mode: "trusted" };

async function seed(scheduledToolPolicy: CronScheduledToolPolicy) {
  const { storePath } = await makeStorePath();
  const cron = createReadService({
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: async () => ({ status: "skipped" }),
  });
  const job = await cron.add(
    {
      ...createHistoryJob("ops", OWNER.sessionKey),
      owner: OWNER,
      payload: { kind: "agentTurn", message: "synthetic sweep", toolsAllow: ["read"] },
    },
    { scheduledToolPolicy },
  );
  await cron.writeScratch(job.id, { content: "notes r1", expectedRevision: 0 });
  const context = createCronTestContext(job, getRuntimeConfig);
  context.cron.readJob.mockImplementation((id) => cron.readJob(id));
  context.cron.getJob.mockImplementation((id) => cron.getJob(id));
  context.cron.readScratch.mockImplementation((...args) => cron.readScratch(...args));
  context.cron.writeScratch.mockImplementation(
    async (...args) =>
      // The fixture mock types only the success shape; the real result is passed through as-is.
      (await cron.writeScratch(...args)) as Awaited<ReturnType<typeof context.cron.writeScratch>>,
  );
  Object.assign(context, {
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  });
  // Isolated runs use their own cron session, never the owner conversation's key.
  const runClient = (claimJobId = job.id, expiresAtMs?: number) =>
    callerClient("ops", "default", `agent:ops:cron:${job.id}`, claimJobId, expiresAtMs);
  return { cron, job, context, runClient };
}

const reply = (respond: ReturnType<typeof vi.fn>) => {
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  return { ok, payload, message: (error as { message?: string } | undefined)?.message };
};

it.each([
  ["trusted", TRUSTED],
  ["account", cronAccountPolicy(OWNER.sessionKey, OWNER.accountId)],
] as const)("a %s job's own run reads and writes its scratch", async (_label, policy) => {
  const { cron, job, context, runClient } = await seed(policy);
  try {
    const client = runClient();
    const read = await invokeCron("cron.scratch.get", { id: job.id }, { context, client });
    expect(reply(read.respond)).toMatchObject({
      ok: true,
      payload: { currentRevision: 1, scratch: { content: "notes r1" } },
    });
    const write = await invokeCron(
      "cron.scratch.set",
      { id: job.id, content: "notes r2", expectedRevision: 1 },
      { context, client },
    );
    expect(reply(write.respond)).toMatchObject({ ok: true, payload: { currentRevision: 2 } });
    expect((await cron.readScratch(job.id)).scratch?.content).toBe("notes r2");
  } finally {
    cron.stop();
  }
});

it("keeps other callers out of a trusted job's scratch", async () => {
  const { cron, job, context, runClient } = await seed(TRUSTED);
  const other = await seed(TRUSTED);
  try {
    const set = (client: ReturnType<typeof runClient>, ctx = context) =>
      invokeCron(
        "cron.scratch.set",
        { id: job.id, content: "injected", expectedRevision: 1 },
        { context: ctx, client },
      );
    // Another conversation of the same agent: not found for both actions.
    const stranger = callerClient("ops", "default", "agent:ops:telegram:group:OTHER");
    const strangerRead = await invokeCron(
      "cron.scratch.get",
      { id: job.id },
      { context, client: stranger },
    );
    expect(reply(strangerRead.respond).message).toContain("Automation not found");
    expect(reply((await set(stranger)).respond).message).toContain("Automation not found");
    // The owner conversation still may not write prompt text under operator authority.
    const owner = callerClient("ops", "default", OWNER.sessionKey);
    expect(reply((await set(owner)).respond).message).toContain("operator access");
    // A run of another job, an expired claim, and a run whose authority ended are refused.
    expect(reply((await set(other.runClient())).respond).message).toContain("Automation not found");
    expect(reply((await set(runClient(job.id, Date.now() - 1))).respond).message).toContain(
      "Automation not found",
    );
    const ended = runClient();
    const authority = ended.internal?.agentRuntimeIdentity?.delegatedAuthority;
    if (authority?.kind !== "local") {
      throw new Error("expected local delegated authority");
    }
    releaseAgentRunDelegatedAuthority(authority);
    expect(reply((await set(ended)).respond).message).toContain("no longer active");
    expect((await cron.readScratch(job.id)).scratch?.content).toBe("notes r1");
  } finally {
    cron.stop();
    other.cron.stop();
  }
});
