import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { mintCronCreatorAuthorityGrant } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

const proofDir = process.env.OPENCLAW_LIVE_SCHEDULED_APP_PROOF_DIR;
const live = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(proofDir);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// This opt-in stage joins the real native-app capture and execution stages using
// an envelope read back from the actual worker-backed cron store, never a fixture copy.
(live ? it : it.skip)(
  "persists native app recapture for the original disabled job owner",
  async () => {
    const artifactDir = expectDefined(proofDir, "proof directory");
    const captured = JSON.parse(
      await fs.readFile(path.join(artifactDir, "capture.json"), "utf8"),
    ) as {
      runtimeAuthority: CronRuntimeAuthority;
      toolsAllow: string[];
      appId: string;
      toolName: string;
      profileId: string;
    };
    expect(captured.runtimeAuthority.namespace).toBe("codex.apps");
    expect(captured.toolsAllow).toHaveLength(1);
    const stateDir = tempDirs.make("openclaw-live-owner-recapture-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionKey = "agent:main:discord:group:live-owner-recapture";
    const sessionId = "live-owner-recapture-session";
    const accountId = "work";
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      commands: { ownerAllowFrom: ["discord:proof-owner"] },
    };
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { sessionKey },
      { sessionId, updatedAt: 1, lifecycleRevision: "live-recapture" },
    );
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const serviceDeps = {
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    };
    let service = new CronService(serviceDeps);
    const runId = "live-owner-recapture";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionId });
    try {
      const owner = { agentId: "main", sessionKey, accountId };
      const created = await service.add(
        {
          name: "Read-only native app proof",
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          agentId: "main",
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: "Read the selected public pull request",
            toolsAllow: ["read"],
          },
          delivery: { mode: "none" },
          owner,
        },
        {
          scheduledToolPolicy: {
            version: 1,
            mode: "account",
            ownerSessionKey: sessionKey,
            ownerAccountId: accountId,
          },
        },
      );
      expect(created.runtimeAuthority).toBeUndefined();
      service.stop();
      service = new CronService(serviceDeps);
      const capability = expectDefined(
        createCronCreatorAuthorityCapability(
          runId,
          { kind: "local" },
          {
            source: "channel-owner",
            isCurrent: () =>
              isConfiguredCommandOwner(getRuntimeConfig(), {
                channel: "discord",
                senderId: "proof-owner",
              }),
          },
        ),
        "live creator capability",
      );
      const identity: AgentRuntimeIdentity = {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        turnSourceChannel: "discord",
        turnSourceAccountId: accountId,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      };
      const context = createDirectChatContext({
        cron: service,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      await runWithCronCreatorAuthorityCapability(capability, () =>
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey, operationalRunInstance, approvalAuthority: authority },
          async () => {
            expect(bindCronManagementGrant(runId)).toBeDefined();
            const tool = createCronTool(
              {
                runId,
                agentSessionKey: sessionKey,
                agentAccountId: accountId,
                creatorToolAllowlist: ["read"],
                resolveCreatorToolAuthority: async () => ({
                  tools: captured.toolsAllow,
                  provenance: { version: 1, source: "final-executable-surface" },
                  grant: mintCronCreatorAuthorityGrant(
                    capability,
                    undefined,
                    captured.runtimeAuthority,
                  ),
                  holdsRuntimeAuthority: true,
                }),
              },
              {
                callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
                  if (!isRecord(params)) {
                    throw new Error("Expected object params");
                  }
                  const client = createSyntheticPluginRuntimeClient();
                  client.internal = {
                    ...client.internal,
                    agentRuntimeIdentity: { ...identity, ...getGatewayToolCallerIdentity() },
                  };
                  const respond = vi.fn<RespondFn>();
                  await expectDefined(
                    cronHandlers[method],
                    method,
                  )({
                    req: { type: "req", id: "live-app-owner-update", method, params },
                    params,
                    client,
                    context,
                    respond,
                    isWebchatConnect: () => false,
                  });
                  const [ok, result, error] = expectDefined(
                    respond.mock.calls[0],
                    "Gateway response",
                  );
                  if (!ok) {
                    throw new Error(error?.message);
                  }
                  return result as T;
                },
              },
            );
            await expect(
              tool.execute("live-owner-update", {
                action: "update",
                jobId: created.id,
                job: { payload: { toolsAllow: captured.toolsAllow } },
              }),
            ).resolves.toMatchObject({ details: { id: created.id } });
          },
        ),
      );
      service.stop();
      service = new CronService(serviceDeps);
      const reopened = expectDefined(
        (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
        "reopened stored job",
      );
      expect(await service.readJob(created.id)).toEqual(reopened);
      expect(reopened.runtimeAuthority).toEqual(captured.runtimeAuthority);
      expect(reopened.runtimeAuthorityRecoveryRequired).toBeUndefined();
      expect(reopened).toMatchObject({
        id: created.id,
        owner,
        enabled: false,
        schedule: created.schedule,
        createdAtMs: created.createdAtMs,
      });
      expect(resolveCronRunToolsAllow(reopened)).toEqual(captured.toolsAllow);
      expect(serviceDeps.runIsolatedAgentJob).not.toHaveBeenCalled();
      await fs.writeFile(
        path.join(artifactDir, "persisted.json"),
        JSON.stringify({
          ...captured,
          runtimeAuthority: reopened.runtimeAuthority,
          toolsAllow: resolveCronRunToolsAllow(reopened),
          persistedJobId: reopened.id,
          disabled: !reopened.enabled,
        }),
        { mode: 0o600 },
      );
      console.log(
        "OWNER_RECAPTURE persisted=true reopened=true disabled_preserved=true authority_equal=true",
      );
    } finally {
      service.stop();
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(runId);
      await cleanupSessionStateForTest({ stateDir });
      clearRuntimeConfigSnapshot();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
  120_000,
);
