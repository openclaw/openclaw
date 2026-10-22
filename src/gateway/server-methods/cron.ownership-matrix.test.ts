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
  cronAccountPolicy as policy,
  expectCronReply,
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
vi.mock("../../cron/delivery-preview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/delivery-preview.js")>()),
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

// "revoked" is a channel-owner manager whose ownership is removed after admission, before the write.
type Caller = "scoped" | "creator" | "manager" | "revoked";
const CALLERS: Caller[] = ["scoped", "creator", "manager", "revoked"];

const OWNER_CONFIG = {
  agents: { entries: { ops: {} } },
  commands: { ownerAllowFrom: ["telegram:owner-1"] },
} as OpenClawConfig;

// Runtime state is rewritten when the service loads; the edit can only touch the definition.
const definition = (job: CronJob | undefined) =>
  job && {
    enabled: job.enabled,
    owner: job.owner,
    payload: job.payload,
    scheduledToolPolicy: job.scheduledToolPolicy,
  };

function expectAllowed(caller: Caller, shape: Partial<CronJob>, opName: string): boolean {
  const ownSession = shape.owner?.sessionKey === S_A;
  if (caller === "scoped" || caller === "creator") {
    return ownSession && shape.owner?.accountId === "default";
  }
  // Management keeps creator attribution: a manager's own-session cap still needs a fresh capture.
  return caller === "manager" && !(opName === "cap" && ownSession);
}

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
    caller === "manager" || caller === "revoked"
      ? { source: "channel-owner", isCurrent: isOwner }
      : undefined,
  );
  try {
    return await runWithCronCreatorAuthorityCapability(scope, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        if (caller === "manager" || caller === "revoked") {
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
    getRuntimeConfig.mockReset().mockReturnValue(OWNER_CONFIG);
    setCronValidationTestRegistry();
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("filters operator commands and foreign streams from caller-scoped cron.list", async () => {
    getRuntimeConfig.mockReturnValue({});
    const owner = { agentId: "ops", sessionKey: "agent:ops:main", accountId: "default" };
    const streamPolicy = policy(owner.sessionKey, owner.accountId);
    const streams = [
      { id: "operator-stream" },
      { id: "trusted-stream", scheduledToolPolicy: { version: 1, mode: "trusted" } },
      { id: "own-stream", owner, scheduledToolPolicy: streamPolicy },
      {
        id: "foreign-session-stream",
        owner: { ...owner, sessionKey: "agent:ops:other" },
        scheduledToolPolicy: { ...streamPolicy, ownerSessionKey: "agent:ops:other" },
      },
      {
        id: "foreign-account-stream",
        owner: { ...owner, accountId: "other" },
        scheduledToolPolicy: { ...streamPolicy, ownerAccountId: "other" },
      },
    ] satisfies Partial<CronJob>[];
    const context = createCronTestContext(
      [
        createCronJob({
          id: "command-job",
          agentId: "ops",
          payload: {
            kind: "command",
            argv: ["deploy"],
            env: { MARKER_ENV: "fixture-marker" },
          },
        }),
        createCronJob({ id: "agent-job", agentId: "ops", name: "agent job" }),
        createCronJob({
          id: "trusted-job",
          owner,
          scheduledToolPolicy: { version: 1, mode: "trusted" },
        }),
        ...streams.map((stream) =>
          createCronJob({
            agentId: "ops",
            schedule: { kind: "stream", command: ["fixture-private-watcher"] },
            ...stream,
          }),
        ),
      ],
      getRuntimeConfig,
    );

    const { respond } = await invokeCron(
      "cron.list",
      { includeDisabled: true, compact: true },
      { context, client: createCronCallerClient("ops") },
    );

    expectCronReply(
      respond,
      expect.objectContaining({
        total: 2,
        jobs: [
          expect.objectContaining({ id: "agent-job" }),
          expect.objectContaining({ id: "own-stream" }),
        ],
      }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("fixture-marker");
    const operatorGet = await invokeCron("cron.get", { id: "trusted-job" }, { context });
    expectCronReply(operatorGet.respond, expect.objectContaining({ id: "trusted-job" }));
  });

  // Every ownership shape x caller x tool-runtime edit, through the Gateway handlers and the SQLite service.
  it("allows only the recorded owner or live management to change prompt or tools", async () => {
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
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          });
          const context = createCronTestContext(undefined, getRuntimeConfig);
          context.cron.readJob.mockImplementation((id) => cron.readJob(id));
          context.cron.getJob.mockImplementation((id) => cron.getJob(id));
          context.cron.getDefaultAgentId.mockImplementation(() => "ops");
          getRuntimeConfig.mockReturnValue(OWNER_CONFIG);
          context.cron.updateWithPrecondition.mockImplementation((...args) => {
            if (caller === "revoked") {
              getRuntimeConfig.mockReturnValue({ ...OWNER_CONFIG, commands: {} });
            }
            return cron.updateWithPrecondition(...args);
          });
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
          if (after && !isDeepStrictEqual(after.owner, before?.owner)) {
            violations.push(`${cell}: owner changed`);
          }
          if (ok !== expectAllowed(caller, shape, opName)) {
            violations.push(`${cell}: ${ok ? "allowed" : `refused (${message})`}`);
          }
          if (!ok && !isDeepStrictEqual(definition(after), definition(before))) {
            violations.push(`${cell}: refused edit changed the stored job`);
          }
          if (ok && after?.payload.kind === "agentTurn" && after.payload.message === "m") {
            violations.push(`${cell}: allowed edit was not stored`);
          }
          if (chat && after?.scheduledToolPolicy?.mode === "trusted" && shapeName !== "trusted") {
            violations.push(`${cell}: chat produced trusted authority`);
          }
          if (/scheduled account policy|persisted job owner/.test(message)) {
            violations.push(`${cell}: internal refusal text`);
          }
          if (chat && shapeName === "sessNoAcct") {
            expect(message).toContain("belongs to another conversation or account");
          }
        }
      }
    }
    expect(violations).toEqual([]);
  }, 300_000);
});
