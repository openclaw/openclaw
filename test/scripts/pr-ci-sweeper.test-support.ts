import type {
  classifyPrForSweep,
  classifyRunForRevive,
} from "../../scripts/github/pr-ci-sweeper.mjs";

export const NOW = Date.parse("2026-07-18T12:00:00Z");
export const MINUTES = 60 * 1000;
export const HOURS = 60 * MINUTES;

export function pr(overrides: Partial<Parameters<typeof classifyPrForSweep>[0]["pr"]> = {}) {
  return {
    draft: false,
    created_at: new Date(NOW - 2 * HOURS).toISOString(),
    updated_at: new Date(NOW - 30 * MINUTES).toISOString(),
    mergeable: true,
    auto_merge: null,
    ...overrides,
  };
}

type FakeCall = { method: string; args: Record<string, unknown> };
type FakeWorkflowRun = Parameters<typeof classifyRunForRevive>[0]["run"] & {
  id: number;
  workflow_id: number | null;
};
type FakeCheckRun = {
  id: number;
  name: string;
  status?: string;
  conclusion: string | null;
  app: { slug: string } | null;
  details_url: string | null | undefined;
};

export function fakeGithub(options: {
  prs: Array<Record<string, unknown>>;
  runsBySha: Record<
    string,
    Array<{ conclusion: string | null; event?: string; id?: number; status?: string }>
  >;
  checksByRef?: Record<string, FakeCheckRun[] | FakeCheckRun[][]>;
  workflowRunsById?: Record<number, FakeWorkflowRun>;
  workflowRunErrorsById?: Record<number, Error>;
  pullsGetByNumber?: Record<number, Record<string, unknown> | Array<Record<string, unknown>>>;
  events?: Array<Record<string, unknown>>;
  pageSize?: number;
}) {
  const calls: FakeCall[] = [];
  const pullsGetCallCounts = new Map<number, number>();
  const checksListCallCounts = new Map<string, number>();
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const github = {
    paginate: (
      endpoint: { endpointName: string },
      args: Record<string, unknown>,
      mapFn?: (response: { data: unknown[] }, done: () => void) => unknown[],
    ) => {
      record(endpoint.endpointName, args);
      // Emulate octokit's paged mapFn contract: the page where done() fires is
      // still included in the result, and later pages are never fetched.
      const paged = (items: unknown[]) => {
        if (!mapFn) {
          return Promise.resolve(items);
        }
        const pageSize = options.pageSize ?? Math.max(items.length, 1);
        const collected: unknown[] = [];
        let stopped = false;
        for (let start = 0; start < items.length; start += pageSize) {
          record(`${endpoint.endpointName}.page`, { start });
          collected.push(
            ...mapFn({ data: items.slice(start, start + pageSize) }, () => {
              stopped = true;
            }),
          );
          if (stopped) {
            break;
          }
        }
        return Promise.resolve(collected);
      };
      if (endpoint.endpointName === "pulls.list") {
        return paged(options.prs);
      }
      if (endpoint.endpointName === "actions.listWorkflowRuns") {
        return Promise.resolve(
          Array.from(options.runsBySha[args.head_sha as string] ?? [], (run) => ({
            ...run,
            event: run.event ?? "pull_request",
          })).filter((run) => !args.event || run.event === args.event),
        );
      }
      if (endpoint.endpointName === "checks.listForRef") {
        const ref = args.ref as string;
        const configured = options.checksByRef?.[ref] ?? [];
        if (Array.isArray(configured[0])) {
          const snapshots = configured as FakeCheckRun[][];
          const callIndex = checksListCallCounts.get(ref) ?? 0;
          checksListCallCounts.set(ref, callIndex + 1);
          return Promise.resolve(snapshots[Math.min(callIndex, snapshots.length - 1)] ?? []);
        }
        return Promise.resolve(configured as FakeCheckRun[]);
      }
      if (endpoint.endpointName === "issues.listEvents") {
        return Promise.resolve(options.events ?? []);
      }
      throw new Error(`unexpected paginate ${endpoint.endpointName}`);
    },
    rest: {
      pulls: {
        list: { endpointName: "pulls.list" },
        get: (args: Record<string, unknown>) => {
          record("pulls.get", args);
          const pullNumber = args.pull_number as number;
          const configured = options.pullsGetByNumber?.[pullNumber];
          const callIndex = pullsGetCallCounts.get(pullNumber) ?? 0;
          pullsGetCallCounts.set(pullNumber, callIndex + 1);
          const match = Array.isArray(configured)
            ? configured[Math.min(callIndex, configured.length - 1)]
            : (configured ?? options.prs.find((entry) => entry.number === pullNumber));
          return Promise.resolve({ data: match });
        },
        update: (args: Record<string, unknown>) => {
          record("pulls.update", args);
          return Promise.resolve({});
        },
      },
      actions: {
        listWorkflowRuns: { endpointName: "actions.listWorkflowRuns" },
        getWorkflowRun: (args: Record<string, unknown>) => {
          record("actions.getWorkflowRun", args);
          const runId = args.run_id as number;
          const error = options.workflowRunErrorsById?.[runId];
          if (error) {
            return Promise.reject(error);
          }
          return Promise.resolve({ data: options.workflowRunsById?.[runId] });
        },
        reRunWorkflow: (args: Record<string, unknown>) => {
          record("actions.reRunWorkflow", args);
          return Promise.resolve({});
        },
      },
      checks: { listForRef: { endpointName: "checks.listForRef" } },
      issues: {
        listEvents: { endpointName: "issues.listEvents" },
        createComment: (args: Record<string, unknown>) => {
          record("issues.createComment", args);
          return Promise.resolve({});
        },
      },
    },
  };
  return { github, calls };
}

export const context = { repo: { owner: "openclaw", repo: "openclaw" } };
export const core = { info: () => {}, setFailed: () => {} };

export function recordingCore() {
  const logs: string[] = [];
  return {
    core: {
      info: (message: string) => logs.push(message),
      setFailed: () => {},
    },
    logs,
  };
}

export function autoMergePr(number: number, headSha: string) {
  return {
    ...pr({ auto_merge: { merge_method: "squash" } }),
    number,
    state: "open",
    head: { sha: headSha, ref: "automation/refresh" },
  };
}

export function githubActionsCheck(
  runId: number,
  overrides: Partial<FakeCheckRun> = {},
): FakeCheckRun {
  return {
    id: runId,
    name: "proof",
    conclusion: "cancelled",
    status: "completed",
    app: { slug: "github-actions" },
    details_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/456`,
    ...overrides,
  };
}

export function cancelledRun(
  runId: number,
  overrides: Partial<FakeWorkflowRun> = {},
): FakeWorkflowRun {
  return {
    id: runId,
    workflow_id: 10,
    conclusion: "cancelled",
    event: "pull_request_target",
    run_attempt: 1,
    created_at: new Date(NOW - HOURS).toISOString(),
    head_branch: "automation/refresh",
    head_repository: { full_name: "openclaw/openclaw" },
    ...overrides,
  };
}
