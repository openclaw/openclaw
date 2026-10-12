import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJobPatch } from "../../cron/types.js";
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
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const sessionKey = "agent:main:discord:group:policy-adoption";
const sessionId = "scheduled-policy-session";
const accountId = "work";
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  commands: { ownerAllowFrom: ["discord:owner-1"] },
};
const accountPolicy = {
  version: 1,
  mode: "account",
  ownerSessionKey: sessionKey,
  ownerAccountId: accountId,
} as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string | undefined;
let cron: CronService | undefined;

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-scheduled-policy-adoption-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot(cfg);
  replaceSessionEntrySync(
    { sessionKey },
    { sessionId, updatedAt: 1, lifecycleRevision: "policy-adoption" },
  );
});

afterEach(async () => {
  cron?.stop();
  cron = undefined;
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
  }
  stateDir = undefined;
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withAgentManagement<T>(
  run: (
    identity: AgentRuntimeIdentity,
    management: NonNullable<ReturnType<typeof bindCronManagementGrant>>,
  ) => Promise<T>,
): Promise<T> {
  const runId = "scheduled-policy-management";
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, { agentId: "main", sessionKey, sessionId });
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey,
    turnSourceChannel: "discord",
    turnSourceAccountId: accountId,
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  try {
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        { kind: "unknown" },
        {
          source: "channel-owner",
          isCurrent: () =>
            isConfiguredCommandOwner(getRuntimeConfig(), {
              channel: "discord",
              senderId: "owner-1",
            }),
        },
      ),
      "current management capability",
    );
    return await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, operationalRunInstance, approvalAuthority: authority },
        () => run(identity, expectDefined(bindCronManagementGrant(runId), "management binding")),
      ),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    clearAgentRunContext(runId);
  }
}

describe("cron.update scheduled policy adoption", () => {
  it.each([
    { caller: "agent management", definition: "known account", expected: accountPolicy },
    { caller: "operator", definition: "known account", expected: accountPolicy },
    { caller: "agent management", definition: "erased policy", expected: undefined },
    { caller: "operator", definition: "erased policy", expected: { version: 1, mode: "trusted" } },
  ] as const)(
    "applies the authorized policy when $caller restores $definition",
    async ({ caller, definition, expected }) => {
      const storePath = path.join(
        expectDefined(stateDir, "test state directory"),
        "cron",
        "jobs.json",
      );
      const service = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      cron = service;
      const owner = { agentId: "main", sessionKey, accountId };
      const created = await service.add(
        {
          name: "Scheduled account policy",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          agentId: "main",
          sessionKey,
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Check status", toolsAllow: ["message"] },
          delivery: { mode: "none" },
          owner,
        },
        { scheduledToolPolicy: accountPolicy },
      );
      const context = createDirectChatContext({
        cron: service,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const update = async (client: GatewayClient, patch: CronJobPatch) => {
        const params = { id: created.id, patch };
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers["cron.update"],
          "cron.update",
        )({
          req: { type: "req", id: "policy-update", method: "cron.update", params },
          params,
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron update response");
        expect({ ok, error }).toEqual({ ok: true, error: undefined });
        expect(result).toMatchObject({ id: created.id });
      };
      const exercise = async (callUpdate: (patch: CronJobPatch) => Promise<void>) => {
        await callUpdate({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "Check status" },
        });
        const store = await loadCronStore(storePath);
        const dormant = expectDefined(
          store.jobs.find((job) => job.id === created.id),
          "dormant job",
        );
        expect(dormant).toMatchObject({
          sessionTarget: "main",
          payload: { kind: "systemEvent", toolsAllow: ["message"] },
          scheduledToolPolicy: accountPolicy,
        });
        if (definition === "erased policy") {
          // Canonical legacy state retained the tool cap without a scheduled policy.
          delete dormant.scheduledToolPolicy;
          await saveCronStore(storePath, store);
          expect(
            (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id)
              ?.scheduledToolPolicy,
          ).toBeUndefined();
        }
        await callUpdate({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Check status" },
        });
        const restored = expectDefined(
          (await loadCronStore(storePath)).jobs.find((job) => job.id === created.id),
          "restored job",
        );
        expect(restored).toMatchObject({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", toolsAllow: ["message"] },
          owner,
        });
        expect(restored.scheduledToolPolicy).toEqual(expected);
      };
      if (caller === "agent management") {
        await withAgentManagement((identity, management) =>
          exercise((patch) => {
            const client = createSyntheticPluginRuntimeClient();
            client.internal = {
              ...client.internal,
              agentRuntimeIdentity: {
                ...identity,
                cronManagementGrant: management.mint("cron.update"),
              },
            };
            return update(client, patch);
          }),
        );
      } else {
        await exercise((patch) =>
          update(createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }), patch),
        );
      }
    },
  );
});
