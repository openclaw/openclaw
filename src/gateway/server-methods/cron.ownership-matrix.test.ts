import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindCronManagementGrant,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import {
  createCronCallerClient,
  createCronJob,
  createCronTestContext,
  createCronTestInvoker,
  setCronValidationTestRegistry,
} from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
vi.mock("../../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js")),
  getRuntimeConfig,
}));
vi.mock("../../cron/inference-binding.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/inference-binding.runtime.js")>()),
  captureCronInferenceBinding: async () => undefined,
}));
vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryFailurePreview: async () => undefined,
  resolveCronDeliveryPreview: async () => ({ label: "x", detail: "x" }),
  resolveCronDeliveryPreviews: async ({ jobs }: { jobs: Array<{ id: string }> }) =>
    Object.fromEntries(jobs.map((job) => [job.id, { label: "x", detail: "x" }])),
}));

import { cronHandlers } from "./cron.js";

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-ownership-matrix-" });

const S_A = "agent:ops:telegram:group:GROUP_A";
const S_B = "agent:ops:telegram:group:GROUP_B";
const S_C = "agent:ops:telegram:group:GROUP_C";
const policy = (sessionKey: string, accountId: string) => ({
  version: 1 as const,
  mode: "account" as const,
  ownerSessionKey: sessionKey,
  ownerAccountId: accountId,
});

const SHAPES: Record<string, Partial<CronJob> & { dropOwner?: boolean }> = {
  none: { payload: { kind: "agentTurn", message: "m" } },
  noneCapped: { payload: { kind: "agentTurn", message: "m", toolsAllow: ["read"] } },
  acctOnly: { owner: { accountId: "default" }, payload: { kind: "agentTurn", message: "m" } },
  agentOnly: { owner: { agentId: "ops" }, payload: { kind: "agentTurn", message: "m" } },
  sessNoAcct: {
    owner: { agentId: "ops", sessionKey: S_A },
    payload: { kind: "agentTurn", message: "m" },
  },
  selfCapless: {
    owner: { agentId: "ops", sessionKey: S_A, accountId: "default" },
    payload: { kind: "agentTurn", message: "m" },
  },
  selfPolicy: {
    owner: { agentId: "ops", sessionKey: S_A, accountId: "default" },
    scheduledToolPolicy: policy(S_A, "default"),
    payload: { kind: "agentTurn", message: "m", toolsAllow: ["read"] },
  },
  otherSessPolicy: {
    owner: { agentId: "ops", sessionKey: S_B, accountId: "default" },
    scheduledToolPolicy: policy(S_B, "default"),
    payload: { kind: "agentTurn", message: "m", toolsAllow: ["read"] },
  },
  otherSessCapless: {
    owner: { agentId: "ops", sessionKey: S_B, accountId: "default" },
    payload: { kind: "agentTurn", message: "m" },
  },
  otherAcct: {
    owner: { agentId: "ops", sessionKey: S_C, accountId: "work" },
    scheduledToolPolicy: policy(S_C, "work"),
    payload: { kind: "agentTurn", message: "m", toolsAllow: ["read"] },
  },
  trusted: {
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    payload: { kind: "agentTurn", message: "m", toolsAllow: ["read"] },
  },
};

const OPS: Record<string, Record<string, unknown>> = {
  prompt: { payload: { kind: "agentTurn", message: "p2" } },
  cap: { payload: { kind: "agentTurn", message: "p3", toolsAllow: ["read"] } },
};

type Caller = "scoped" | "creator" | "manager";
const CALLERS: Caller[] = ["scoped", "creator", "manager"];

async function updateAs(
  caller: Caller,
  params: Record<string, unknown>,
  context: ReturnType<typeof createCronTestContext>,
) {
  const client: GatewayClient = createCronCallerClient("ops", "default", S_A);
  const identity = client.internal!.agentRuntimeIdentity!;
  identity.turnSourceChannel = "telegram";
  if (caller === "scoped") {
    return await invokeCron("cron.update", params, { context, client });
  }
  const authority = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
  identity.delegatedAuthority = { kind: "local", ...authority };
  context.validateAgentRuntimeApprovalAuthority = () => true;
  const isOwner = () =>
    isConfiguredCommandOwner(getRuntimeConfig(), { channel: "telegram", senderId: "owner-1" });
  const scope = createCronCreatorAuthorityRunScope(
    identity.operationalRunInstance.runId,
    { kind: "external", channel: "telegram" },
    caller === "manager" ? { source: "channel-owner", isCurrent: isOwner } : undefined,
  );
  try {
    return await runWithCronCreatorAuthorityCapability(scope, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        if (caller === "manager") {
          identity.cronManagementGrant = bindCronManagementGrant(scope.runId)!.mint("cron.update");
        } else {
          identity.cronToolsAllowCapture = "final-executable-surface";
          identity.cronCreatorAuthorityGrant = mintCronCreatorAuthorityGrant(scope);
        }
        return await invokeCron("cron.update", params, { context, client });
      }),
    );
  } finally {
    revokeCronCreatorAuthorityRunScope(scope);
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("cron ownership access matrix", () => {
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({
      agents: { entries: { ops: {} } },
      commands: { ownerAllowFrom: ["telegram:owner-1"] },
    } as OpenClawConfig);
    setCronValidationTestRegistry();
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  // Every ownership shape x caller x tool-runtime edit, through the Gateway handlers and the SQLite service.
  it("keeps owner attribution and tool authority bound to the recorded owner", async () => {
    const violations: string[] = [];
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      for (const caller of CALLERS) {
        for (const [opName, patch] of Object.entries(OPS)) {
          const cell = `${shapeName}/${caller}/${opName}`;
          const { storePath } = await makeStorePath();
          const seeded = createCronJob({ enabled: true, agentId: "ops", ...shape });
          if (!shape.owner) {
            delete seeded.owner;
          }
          await saveCronStore(storePath, { version: 1, jobs: [seeded] });
          const before = (await loadCronStore(storePath)).jobs[0];
          const cron = new CronService({
            scheduler: createTestGatewayScheduler(),
            nowMs: () => Date.now(),
            storePath,
            cronEnabled: false,
            defaultAgentId: "ops",
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          });
          const context = createCronTestContext(undefined, getRuntimeConfig);
          context.cron.readJob.mockImplementation((id) => cron.readJob(id));
          context.cron.getJob.mockImplementation((id) => cron.getJob(id));
          context.cron.getDefaultAgentId.mockImplementation(() => "ops");
          context.cron.updateWithPrecondition.mockImplementation((...args) =>
            cron.updateWithPrecondition(...args),
          );
          let ok = false;
          let message = "";
          try {
            const { respond } = await updateAs(caller, { id: seeded.id, patch }, context);
            const [responseOk, , error] = respond.mock.calls[0] ?? [];
            ok = responseOk === true;
            message = String(error?.message ?? "");
          } catch (err) {
            violations.push(`${cell}: handler threw ${String(err)}`);
          } finally {
            cron.stop();
          }
          const after = (await loadCronStore(storePath)).jobs.find((job) => job.id === seeded.id);
          const chat = caller === "scoped" || caller === "creator";
          const ownedByCaller = shapeName === "selfCapless" || shapeName === "selfPolicy";
          if (after && !isDeepStrictEqual(after.owner, before?.owner)) {
            violations.push(`${cell}: owner changed`);
          }
          if (chat && ok && !ownedByCaller) {
            violations.push(`${cell}: chat changed a job it does not own`);
          }
          if (chat && after?.scheduledToolPolicy?.mode === "trusted" && shapeName !== "trusted") {
            violations.push(`${cell}: chat produced trusted authority`);
          }
          if (/scheduled account policy|persisted job owner/.test(message)) {
            violations.push(`${cell}: internal refusal text`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  }, 300_000);
});
