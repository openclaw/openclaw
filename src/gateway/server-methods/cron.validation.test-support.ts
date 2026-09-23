import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import type { CronJob } from "../../cron/types.js";
import type { GatewayRequestContext } from "./types.js";

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
      getDefaultAgentId: vi.fn(() => "main"),
      getJob: vi.fn((id: string) => jobs.find((job) => job.id === id)),
      prepareWake: vi.fn(async () => undefined),
      wake: vi.fn(() => ({ ok: true }) as const),
      readJob: vi.fn(async (id: string) => jobs.find((job) => job.id === id)),
      readScratch: vi.fn(async () => ({ content: null, revision: 0 })),
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
            jobs: pageJobs,
            snapshotRevision: `fixture:${filteredJobs.map((job) => job.id).join(",")}`,
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
