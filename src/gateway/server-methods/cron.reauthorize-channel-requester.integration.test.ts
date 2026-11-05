import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { resolveCronCreatorSandbox } from "../../cron/creator-sandbox.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { registerActiveCronTaskRun } from "../../cron/service/active-run-cancellation.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let cron: CronService | undefined;
let stateDir: string | undefined;
afterEach(async () => {
  cron?.stop();
  await cron?.waitForIdle();
  cron = undefined;
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
  }
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function fixture(
  initial: Pick<
    NonNullable<Parameters<CronService["add"]>[1]>,
    "createdActor" | "toolsAllowProvenance"
  > = {},
) {
  stateDir = tempDirs.make("cron-reauthorize-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  ensureGatewayOwnerProfile(null);
  const profile = ensureProfileForEmail("requester@example.test");
  const identity = { channelId: "discord", accountId: "work", senderId: "sender-1" };
  await changeCanonicalUserChannelIdentity("link", profile.id, identity);
  const service = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath: path.join(stateDir, "cron", "jobs.json"),
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  cron = service;
  const job = await service.add(
    {
      name: "Legacy original",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Keep exact payload", toolsAllow: ["read"] },
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: "agent:main:main", accountId: "work" },
    },
    {
      createdActor: { type: "human", source: "channel", id: "historical-sender" },
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "discord" },
      },
      ...initial,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:main",
        ownerAccountId: "work",
      },
    },
  );
  if ("job" in job) {
    throw new Error("Expected a newly created job");
  }
  const client = {
    connId: "admin",
    authenticatedUserProfile: {
      profileId: GATEWAY_OWNER_PROFILE_ID,
      displayName: null,
      hasAvatar: false,
      updatedAt: 0,
    },
    connect: { role: "operator", scopes: ["operator.admin"] },
  } as GatewayClient;
  const context = createDirectChatContext({ cron: service, getRuntimeConfig: () => cfg });
  const params = {
    id: job.id,
    channel: "discord",
    accountId: "work",
    senderId: "sender-1",
    expectedProfileId: profile.id,
    expectedConfigRevision: resolveCronJobConfigRevision(job),
  };
  const invoke = async (patch: Record<string, unknown> = {}, beforeCommit?: () => void) => {
    const respond = vi.fn();
    await cronHandlers["cron.reauthorizeChannelRequester"]!({
      req: { method: "cron.reauthorizeChannelRequester" } as never,
      params: { ...params, ...patch },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      sessionMutationCommitGuard: beforeCommit,
    });
    return respond;
  };
  return { service, job, identity, client, profile, invoke, cfg };
}

describe("cron.reauthorizeChannelRequester production mutation", () => {
  it("closes nonmessage tool admission only after a requester rebind commits", async () => {
    const f = await fixture({
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "discord" },
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "work",
          senderId: "sender-a",
        },
      },
    });
    const a = ensureProfileForEmail("requester-a@example.test");
    await changeCanonicalUserChannelIdentity("link", a.id, { ...f.identity, senderId: "sender-a" });
    f.cfg.gateway = {
      roles: {
        default: "unrestricted",
        definitions: {
          unrestricted: { sessions: { others: "none" }, agents: "*", scopes: [] },
          isolated: { sessions: { others: "none" }, agents: "*", scopes: [], sandbox: "required" },
        },
      },
    };
    await setCanonicalUserProfileRole(f.profile.id, "isolated");
    const creator = await resolveCronCreatorSandbox(f.cfg, f.job);
    expect(creator.sandbox).toBeUndefined();
    const marker = markCronJobActive(f.job.id);
    const controller = new AbortController();
    const release = registerActiveCronTaskRun({
      runId: "reauthorize-active",
      controller,
      activeJobMarker: marker,
    });
    try {
      const tools = createOpenClawCodingTools({
        config: f.cfg,
        agentId: "main",
        workspaceDir: stateDir!,
        cwd: stateDir!,
        abortSignal: controller.signal,
        toolConstructionPlan: {
          includeBaseCodingTools: true,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      });
      const read = tools.find((tool) => tool.name === "read")!;
      expect(read).toBeDefined();
      const target = path.join(stateDir!, "admission-proof.txt");
      await writeFile(target, "synthetic authority proof");
      // A failed real commit must leave the admitted run and its stored job intact.
      const rejected = await f.invoke({}, () => {
        throw new Error("Reject transaction");
      });
      expect(rejected.mock.calls[0]?.[0]).toBe(false);
      expect(await f.service.readJob(f.job.id)).toEqual(f.job);
      expect(controller.signal.aborted).toBe(false);
      await expect(read.execute("retained-read", { path: target })).resolves.toMatchObject({
        content: [{ type: "text", text: "synthetic authority proof" }],
      });
      await f.service.update(f.job.id, { description: "Unrelated metadata" });
      expect(controller.signal.aborted).toBe(false);
      const current = (await f.service.readJob(f.job.id))!;
      const accepted = await f.invoke({
        expectedConfigRevision: resolveCronJobConfigRevision(current),
      });
      expect(accepted.mock.calls[0]?.[0]).toBe(true);
      const rebound = (await f.service.readJob(f.job.id))!;
      expect((await resolveCronCreatorSandbox(f.cfg, rebound)).sandbox).toBe("required");
      // A remains linked and its captured role guard still passes: cancellation owns the cutover.
      creator.assertCurrent();
      await expect(read.execute("old-sandbox-read", { path: target })).rejects.toThrow(/abort/i);
    } finally {
      release?.();
      clearCronJobActive(f.job.id, marker);
    }
  });

  it("binds the verified requester while preserving the original definition and creator history", async () => {
    const f = await fixture();
    const respond = await f.invoke();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const after = await f.service.readJob(f.job.id);
    expect(after).toMatchObject({
      ...f.job,
      updatedAtMs: expect.any(Number),
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "discord" },
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "work",
          senderId: "sender-1",
        },
      },
    });
  });

  it("looks up the normalized tuple before checking the expected profile and persists that tuple", async () => {
    const f = await fixture();
    const collision = ensureProfileForEmail("case-collision@example.test");
    await changeCanonicalUserChannelIdentity("link", collision.id, {
      ...f.identity,
      channelId: "Discord",
    });
    const tuple = { channel: "Discord", accountId: "WORK", senderId: " sender-1 " };
    const rejected = await f.invoke({ channel: "Discord", expectedProfileId: collision.id });
    expect(rejected.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Exact channel identity link"),
    });
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);

    const accepted = await f.invoke(tuple);
    expect(accepted.mock.calls[0]?.[0]).toBe(true);
    expect(await f.service.readJob(f.job.id)).toMatchObject({
      createdActor: f.job.createdActor,
      toolsAllowProvenance: {
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "work",
          senderId: "sender-1",
        },
      },
    });
  });

  it("reauthorizes requester-only provenance while preserving a historical profile creator", async () => {
    const createdActor = { type: "human", source: "profile", id: "historical-profile" } as const;
    const f = await fixture({
      createdActor,
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "work",
          senderId: "historical-sender",
        },
      },
    });
    expect(f.job.toolsAllowProvenance?.callerOrigin).toBeUndefined();
    const respond = await f.invoke();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(await f.service.readJob(f.job.id)).toMatchObject({
      ...f.job,
      createdActor,
      updatedAtMs: expect.any(Number),
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "discord" },
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "work",
          senderId: "sender-1",
        },
      },
    });
  });

  it("reports a missing job as an invalid request", async () => {
    const f = await fixture();
    const respond = await f.invoke({ id: "missing-job" });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);
  });

  it.each([
    { channel: "telegram" },
    { accountId: "personal" },
    { senderId: "someone-else" },
    { expectedProfileId: "different-profile" },
    { expectedConfigRevision: `sha256:${"A".repeat(43)}` },
  ])("rejects mismatched identity, scope, or revision: %j", async (patch) => {
    const f = await fixture();
    if ("channel" in patch || "accountId" in patch) {
      await changeCanonicalUserChannelIdentity("link", f.profile.id, {
        ...f.identity,
        channelId: typeof patch.channel === "string" ? patch.channel : f.identity.channelId,
        accountId: typeof patch.accountId === "string" ? patch.accountId : f.identity.accountId,
      });
    }
    const respond = await f.invoke(patch);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);
  });

  it("rejects scope-only claims without an authenticated administrator", async () => {
    const f = await fixture();
    delete f.client.authenticatedUserProfile;
    const respond = await f.invoke();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);
  });

  it("rechecks administrator scope at the real mutation commit", async () => {
    const f = await fixture();
    const respond = await f.invoke({}, () => {
      f.client.connect.scopes = [];
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);
  });
  it("rejects a nonadmin durable role despite an operator.admin scope claim", async () => {
    const f = await fixture();
    f.cfg.gateway = {
      roles: {
        default: "reader",
        definitions: {
          reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
        },
      },
    };
    f.client.authenticatedUserProfile = {
      profileId: f.profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 0,
    };
    const respond = await f.invoke();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(await f.service.readJob(f.job.id)).toEqual(f.job);
  });

  it.each(["unlink", "role"] as const)(
    "rejects durable %s revocation while awaiting the cron mutation",
    async (revocation) => {
      const f = await fixture();
      f.cfg.gateway = {
        roles: {
          default: "reader",
          definitions: {
            reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            administrator: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.admin"],
            },
          },
        },
      };
      await setCanonicalUserProfileRole(f.profile.id, "administrator");
      f.client.authenticatedUserProfile = {
        profileId: f.profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: 0,
      };
      const update = f.service.updateWithPrecondition.bind(f.service);
      vi.spyOn(f.service, "updateWithPrecondition").mockImplementation(async (...args) => {
        if (revocation === "unlink") {
          await changeCanonicalUserChannelIdentity("unlink", f.profile.id, f.identity);
        } else {
          await setCanonicalUserProfileRole(f.profile.id, "reader");
        }
        return update(...args);
      });
      const respond = await f.invoke();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(await f.service.readJob(f.job.id)).toEqual(f.job);
      vi.restoreAllMocks();
    },
  );
  it("reports persistence failure as unavailable without changing the job", async () => {
    const f = await fixture();
    const update = vi
      .spyOn(f.service, "updateWithPrecondition")
      .mockRejectedValueOnce(new Error("State worker unavailable"));
    try {
      const respond = await f.invoke();
      expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
      expect(await f.service.readJob(f.job.id)).toEqual(f.job);
    } finally {
      update.mockRestore();
    }
  });
});
