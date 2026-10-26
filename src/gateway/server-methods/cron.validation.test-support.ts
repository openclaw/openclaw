import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, onTestFinished, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronListSnapshotRevision } from "../../cron/list-snapshot-revision.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import type { CronService } from "../../cron/service.js";
import type { CronJob } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { CronCreatorAuthorityGrant } from "../cron-creator-authority-grant.types.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type MutationOptions = {
  commitGuard?: () => void;
  captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
};

export function setCronValidationTestRegistry(): void {
  const channels: [id: string, targetPrefixes: string[], aliases?: string[]][] = [
    ["discord", ["discord"]],
    ["telegram", ["telegram", "tg"]],
    ["slack", ["slack"]],
    ["msteams", ["msteams", "teams"], ["teams"]],
    ["synology-chat", ["synology-chat", "synology_chat", "synology"]],
  ];
  setActivePluginRegistry(
    createTestRegistry(
      channels.map(([id, targetPrefixes, aliases]) => {
        const base = createChannelTestPluginBase({
          id,
          config: {
            isConfigured: (_account, cfg) =>
              Boolean(cfg.channels?.[id] && cfg.channels[id].enabled !== false),
          },
        });
        return {
          pluginId: id,
          plugin: {
            ...base,
            meta: { ...base.meta, ...(aliases ? { aliases } : {}) },
            messaging: { targetPrefixes },
          },
          source: `test:${id}`,
        };
      }),
    ),
  );
}

export function createCronTestContext(
  currentJobs: CronJob | CronJob[] | undefined,
  getRuntimeConfig: () => OpenClawConfig,
) {
  const jobs = currentJobs ? (Array.isArray(currentJobs) ? currentJobs : [currentJobs]) : [];
  const committedAdds: Partial<CronJob>[] = [];
  const committedRuntimeAuthorities: Array<CronRuntimeAuthority | undefined> = [];
  const committedRuntimeAuthorityCaptures: boolean[] = [];
  const committedUpdates: Array<{ id: string; patch: Partial<CronJob> }> = [];
  const captureAuthority = (opts?: MutationOptions) => {
    opts?.commitGuard?.();
    committedRuntimeAuthorityCaptures.push(opts?.captureRuntimeAuthority !== undefined);
    committedRuntimeAuthorities.push(opts?.captureRuntimeAuthority?.());
  };
  const update = vi.fn(async (id: string, patch: Partial<CronJob>) => {
    committedUpdates.push({ id, patch });
    return createCronJob({ ...jobs.find((job) => job.id === id), ...patch, id });
  });
  return {
    committedAdds,
    committedRuntimeAuthorities,
    committedRuntimeAuthorityCaptures,
    committedUpdates,
    cron: {
      add: vi.fn(async (input: Partial<CronJob>, opts?: MutationOptions) => {
        captureAuthority(opts);
        committedAdds.push(input);
        return createCronJob({ ...input, id: "cron-1" });
      }),
      update,
      updateWithPrecondition: vi.fn(
        async (
          id: string,
          patch: Partial<CronJob>,
          precondition: (job: CronJob, nowMs: number) => void | Promise<void>,
          opts?: MutationOptions,
        ) => {
          const job = jobs.find((candidate) => candidate.id === id);
          if (!job) {
            throw new Error(`unknown automation id: ${id}`);
          }
          await precondition(job, Date.now());
          captureAuthority(opts);
          return await update(id, patch);
        },
      ),
      remove: vi.fn(async (_id: string, opts?: { commitGuard?: () => void }) => {
        opts?.commitGuard?.();
        return { ok: true, removed: true };
      }),
      enqueueRun: vi.fn(
        async (_id: string, _mode?: string, opts?: { commitGuard?: () => void }) => {
          opts?.commitGuard?.();
          return { ok: true, enqueued: true, runId: "run-1" };
        },
      ),
      waitForManualRun: vi.fn(async () => false),
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn((id: string) => jobs.find((job) => job.id === id)),
      getLoadedJobs: vi.fn(() => jobs),
      prepareWake: vi.fn(async () => undefined),
      wake: vi.fn(async (opts: Parameters<CronService["wake"]>[0]) => {
        opts.commitGuard?.();
        return { ok: true } as const;
      }),
      readJob: vi.fn(async (id: string) => jobs.find((job) => job.id === id)),
      readScratch: vi.fn<CronService["readScratch"]>(async () => ({ currentRevision: 0 })),
      writeScratch: vi.fn(
        async (_id: string, params: { content: string | null; commitGuard?: () => void }) => {
          params.commitGuard?.();
          const scratch = { content: params.content, revision: 1 };
          return { ok: true as const, scratch, currentRevision: scratch.revision };
        },
      ),
      list: vi.fn(async () => jobs),
      listPage: vi.fn(async (...[opts, matchesJob]: Parameters<CronService["listPage"]>) => {
        const requestedAgentId = opts?.agentId?.trim().toLowerCase();
        const agentJobs = requestedAgentId
          ? jobs.filter((job) => (job.agentId ?? "main").trim().toLowerCase() === requestedAgentId)
          : jobs;
        const filteredJobs = matchesJob ? agentJobs.filter(matchesJob) : agentJobs;
        const total = filteredJobs.length;
        const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? (total || 50))));
        const pageJobs = filteredJobs.slice(offset, offset + limit);
        const nextOffset = offset + pageJobs.length;
        return {
          jobs: freezeJsonSnapshot(structuredClone(pageJobs)),
          snapshotRevision: resolveCronListSnapshotRevision(filteredJobs),
          total,
          offset,
          limit,
          hasMore: nextOffset < total,
          nextOffset: nextOffset < total ? nextOffset : null,
        };
      }),
    },
    logGateway: { info: vi.fn(), warn: vi.fn() },
    cronStorePath: "cron-validation-test.json",
    getRuntimeConfig,
    validateAgentRuntimeApprovalAuthority:
      undefined as GatewayRequestContext["validateAgentRuntimeApprovalAuthority"],
  };
}

export function agentTurnCronParams(overrides: Record<string, unknown> = {}) {
  const { name, enabled, schedule, sessionTarget, wakeMode, payload } = createCronJob();
  return { name, enabled, schedule, sessionTarget, wakeMode, payload, ...overrides };
}

export function createCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron-1",
    name: "cron job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello", toolsAllow: ["*"] },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  };
}

export function cronAccountPolicy(ownerSessionKey: string, ownerAccountId = "default") {
  return { version: 1, mode: "account", ownerSessionKey, ownerAccountId } as const;
}

export function expectCronReply(
  respond: ReturnType<typeof vi.fn>,
  payload: unknown,
  call: "any" | "once" | "last" = "any",
) {
  const assertion = expect(respond);
  if (call === "once") {
    assertion.toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
  } else if (call === "last") {
    assertion.toHaveBeenLastCalledWith(true, payload, undefined);
  } else {
    assertion.toHaveBeenCalledWith(true, payload, undefined);
  }
}

export function expectCronFailure(respond: ReturnType<typeof vi.fn>, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}

export function pluginEntries(...ids: string[]): OpenClawConfig["plugins"] {
  return { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) };
}

export function telegramConfig(): OpenClawConfig {
  return channelConfig({ telegram: { botToken: "telegram-token" } });
}

export function telegramSlackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  const channels = { ...telegramConfig().channels, ...slackConfig().channels };
  return { ...slackConfig(params), ...channelConfig(channels) };
}

export function telegramDisabledAccountConfig(): OpenClawConfig {
  return channelConfig({
    telegram: {
      accounts: {
        primary: { botToken: "telegram-token-primary" },
        retired: { botToken: "telegram-token-retired", enabled: false },
      },
    },
  });
}

export function msteamsConfig(): OpenClawConfig {
  return {
    channels: { msteams: { botToken: "teams-token" } },
    plugins: pluginEntries("msteams"),
  } as OpenClawConfig;
}

export function slackSynologyConfig(): OpenClawConfig {
  return channelConfig({ ...slackConfig().channels, "synology-chat": { token: "synology-token" } });
}

function channelConfig(channels: NonNullable<OpenClawConfig["channels"]>): OpenClawConfig {
  return { channels, plugins: pluginEntries(...Object.keys(channels)) };
}

export function slackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  return {
    ...(params.includeMainSession ? { session: { mainKey: "main" } } : {}),
    ...channelConfig({ slack: { botToken: "xoxb-slack-token", appToken: "xapp-slack-token" } }),
  };
}

export function createCronCallerClient(
  agentId: string,
  accountId?: string,
  sessionKey?: string,
  currentJobId?: string,
  currentJobExpiresAtMs = Date.now() + 60_000,
): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef(
    `run-cron-validation-${randomUUID()}`,
  );
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  onTestFinished(() => {
    releaseAgentRunDelegatedAuthority(authority);
  });
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId,
    sessionKey: sessionKey ?? `agent:${agentId}:main`,
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  if (accountId) {
    identity.turnSourceAccountId = accountId;
  }
  if (currentJobId) {
    identity.cronSelfManagementContext = {
      jobId: currentJobId,
      expiresAtMs: currentJobExpiresAtMs,
    };
  }
  return {
    connect: {} as GatewayClient["connect"],
    internal: { agentRuntimeIdentity: identity },
  };
}

export function createCronTestInvoker(
  handlers: typeof import("./cron.js").cronHandlers,
  getRuntimeConfig: () => OpenClawConfig,
) {
  type CronMethod = keyof typeof handlers;

  return async function invokeCron(
    method: CronMethod,
    params: Record<string, unknown>,
    options: {
      currentJob?: CronJob;
      context?: ReturnType<typeof createCronTestContext>;
      client?: GatewayClient;
      respond?: ReturnType<typeof vi.fn>;
      sessionMutationCommitGuard?: () => void;
      hasCurrentClientAuthority?: () => boolean;
    } = {},
  ) {
    const context = options.context ?? createCronTestContext(options.currentJob, getRuntimeConfig);
    const respond = options.respond ?? vi.fn();
    await expectDefined(
      handlers[method],
      "cronHandlers[method] test invariant",
    )({
      req: {} as never,
      params: params as never,
      respond: respond as never,
      context: context as never,
      client: options.client ?? null,
      sessionMutationCommitGuard: options.sessionMutationCommitGuard,
      hasCurrentClientAuthority: options.hasCurrentClientAuthority,
      isWebchatConnect: () => false,
    });
    return { context, respond };
  };
}

export function expectCronSuccess(respond: ReturnType<typeof vi.fn>): void {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ id: "cron-1" }), undefined);
}

export const requireRecord = createRequireRecord("record", "expected-label-object");

export function requireCronAddPayload(
  context: ReturnType<typeof createCronTestContext>,
): Record<string, unknown> {
  return requireRecord(context.cron.add.mock.calls[0]?.[0], "cron.add payload");
}

export function expectResponseError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code?: string; messageIncludes?: string; details?: Record<string, unknown> },
) {
  const [ok, payload, responseError] = expectDefined(respond.mock.calls[0], "response call");
  expect([ok, payload]).toEqual([false, undefined]);
  const error = requireRecord(responseError, "response error");
  if (expected.code) {
    expect(error.code).toBe(expected.code);
  }
  if (expected.messageIncludes) {
    expect(String(error.message)).toContain(expected.messageIncludes);
  }
  if (expected.details) {
    expect(error.details).toEqual(expected.details);
  }
}

export function callerClientWithCronCreatorAuthority(
  grant: CronCreatorAuthorityGrant,
): GatewayClient {
  const client = createCronCallerClient("ops");
  client.internal!.agentRuntimeIdentity!.cronToolsAllowCapture = "final-executable-surface";
  client.internal!.agentRuntimeIdentity!.cronCreatorAuthorityGrant = grant;
  return client;
}
