import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronListSnapshotRevision } from "../../cron/list-snapshot-revision.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import type { CronService } from "../../cron/service.js";
import type { CronJob } from "../../cron/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes: readonly string[],
  aliases?: readonly string[],
): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id,
    config: {
      isConfigured: (_account, cfg) => {
        const channelConfig = cfg.channels?.[id];
        return Boolean(channelConfig && channelConfig.enabled !== false);
      },
    },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(aliases ? { aliases } : {}),
    },
    messaging: { targetPrefixes },
  };
}

export function setCronValidationTestRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createPrefixOnlyChannelPlugin("discord", ["discord"]),
        source: "test:discord",
      },
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
        source: "test:telegram",
      },
      {
        pluginId: "slack",
        plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]),
        source: "test:slack",
      },
      {
        pluginId: "msteams",
        plugin: createPrefixOnlyChannelPlugin("msteams", ["msteams", "teams"], ["teams"]),
        source: "test:msteams",
      },
      {
        pluginId: "synology-chat",
        plugin: createPrefixOnlyChannelPlugin("synology-chat", [
          "synology-chat",
          "synology_chat",
          "synology",
        ]),
        source: "test:synology-chat",
      },
    ]),
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
  const update = vi.fn(async (id: string, patch: Partial<CronJob>) => {
    committedUpdates.push({ id, patch });
    return createCronJob({
      ...jobs.find((job) => job.id === id),
      ...patch,
      id,
    });
  });
  return {
    committedAdds,
    committedRuntimeAuthorities,
    committedRuntimeAuthorityCaptures,
    committedUpdates,
    cron: {
      add: vi.fn(
        async (
          input: Partial<CronJob>,
          opts?: {
            commitGuard?: () => void;
            captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
          },
        ) => {
          opts?.commitGuard?.();
          committedRuntimeAuthorityCaptures.push(opts?.captureRuntimeAuthority !== undefined);
          committedRuntimeAuthorities.push(opts?.captureRuntimeAuthority?.());
          committedAdds.push(input);
          return createCronJob({ ...input, id: "cron-1" });
        },
      ),
      update,
      updateWithPrecondition: vi.fn(
        async (
          id: string,
          patch: Partial<CronJob>,
          precondition: (job: CronJob, nowMs: number) => void | Promise<void>,
          opts?: {
            commitGuard?: () => void;
            captureRuntimeAuthority?: () => CronRuntimeAuthority | undefined;
          },
        ) => {
          const job = jobs.find((candidate) => candidate.id === id);
          if (!job) {
            throw new Error(`unknown automation id: ${id}`);
          }
          await precondition(job, Date.now());
          opts?.commitGuard?.();
          committedRuntimeAuthorityCaptures.push(opts?.captureRuntimeAuthority !== undefined);
          committedRuntimeAuthorities.push(opts?.captureRuntimeAuthority?.());
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
      prepareWake: vi.fn(async () => undefined),
      wake: vi.fn((opts: Parameters<CronService["wake"]>[0]) => {
        opts.commitGuard?.();
        return { ok: true } as const;
      }),
      readJob: vi.fn(async (id: string) => jobs.find((job) => job.id === id)),
      readScratch: vi.fn<CronService["readScratch"]>(async () => ({ currentRevision: 0 })),
      writeScratch: vi.fn(
        async (_id: string, params: { content: string | null; commitGuard?: () => void }) => {
          params.commitGuard?.();
          return {
            ok: true as const,
            scratch: { content: params.content, revision: 1 },
            currentRevision: 1,
          };
        },
      ),
      list: vi.fn(async () => jobs),
      listPage: vi.fn(
        async (
          opts?: {
            agentId?: string;
            limit?: number;
            offset?: number;
            trigger?: "all" | "conditional" | "unconditional";
          },
          matchesJob?: (job: CronJob) => boolean,
        ) => {
          const requestedAgentId = opts?.agentId?.trim().toLowerCase();
          const agentJobs = requestedAgentId
            ? jobs.filter(
                (job) => (job.agentId ?? "main").trim().toLowerCase() === requestedAgentId,
              )
            : jobs;
          const filteredJobs = matchesJob ? agentJobs.filter(matchesJob) : agentJobs;
          const total = filteredJobs.length;
          const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
          const defaultLimit = total === 0 ? 50 : total;
          const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
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
        },
      ),
    },
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    cronStorePath: "cron-validation-test.json",
    getRuntimeConfig: () => getRuntimeConfig(),
    validateAgentRuntimeApprovalAuthority: undefined as
      | GatewayRequestContext["validateAgentRuntimeApprovalAuthority"]
      | undefined,
  };
}

export function agentTurnCronParams(overrides: Record<string, unknown> = {}) {
  return {
    name: "cron job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello", toolsAllow: ["*"] },
    ...overrides,
  };
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

export function pluginEntries(...ids: string[]): OpenClawConfig["plugins"] {
  return {
    entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
  };
}

export function telegramConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "telegram-token",
      },
    },
    plugins: pluginEntries("telegram"),
  } as OpenClawConfig;
}

export function telegramSlackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  return {
    ...(params.includeMainSession ? { session: { mainKey: "main" } } : {}),
    channels: {
      telegram: {
        botToken: "telegram-token",
      },
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
    },
    plugins: pluginEntries("telegram", "slack"),
  } as OpenClawConfig;
}

export function telegramDisabledAccountConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        accounts: {
          primary: { botToken: "telegram-token-primary" },
          retired: { botToken: "telegram-token-retired", enabled: false },
        },
      },
    },
    plugins: pluginEntries("telegram"),
  } as OpenClawConfig;
}

export function msteamsConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        botToken: "teams-token",
      },
    },
    plugins: pluginEntries("msteams"),
  } as OpenClawConfig;
}

export function slackSynologyConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
      "synology-chat": {
        token: "synology-token",
      },
    },
    plugins: pluginEntries("slack", "synology-chat"),
  } as OpenClawConfig;
}

export function slackConfig(params: { includeMainSession?: boolean } = {}): OpenClawConfig {
  return {
    ...(params.includeMainSession ? { session: { mainKey: "main" } } : {}),
    channels: {
      slack: {
        botToken: "xoxb-slack-token",
        appToken: "xapp-slack-token",
      },
    },
    plugins: pluginEntries("slack"),
  } as OpenClawConfig;
}

export function createCronCallerClient(
  agentId: string,
  accountId?: string,
  sessionKey?: string,
  currentJobId?: string,
  currentJobExpiresAtMs = Date.now() + 60_000,
): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef("run-cron-validation");
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId,
        sessionKey: sessionKey ?? `agent:${agentId}:main`,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "test-generation",
          claimId: "test-claim",
        },
        ...(accountId ? { turnSourceAccountId: accountId } : {}),
        ...(currentJobId
          ? {
              cronSelfManagementContext: {
                jobId: currentJobId,
                expiresAtMs: currentJobExpiresAtMs,
              },
            }
          : {}),
      },
    },
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
  const call = respond.mock.calls.at(0);
  if (!call) {
    throw new Error("expected response call");
  }
  expect(call[0]).toBe(false);
  expect(call[1]).toBeUndefined();
  const error = requireRecord(call[2], "response error");
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
