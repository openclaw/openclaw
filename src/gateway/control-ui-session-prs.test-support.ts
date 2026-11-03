// Shared fixtures for the control-ui session PR tests; test-only module.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext as RawGitCheckoutContext } from "../infra/git-read-operations.js";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ControlUiSessionBranch } from "./control-ui-contract.js";
import {
  prepareSessionPrFixtureRead,
  recordSessionPrFixtureCheckout,
  resolveSessionPrFixtureRequest,
} from "./control-ui-session-pr-access.test-support.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionSourceScope,
} from "./repository-session-read.types.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

type PrRequest = { sessionKey: string; agentId?: string; refresh?: boolean };
type CheckoutFixture = Pick<ControlUiSessionBranch, "owner" | "repo"> &
  Omit<RawGitCheckoutContext, "originUrl"> & { host?: string };
type PrDeps = {
  resolveGitRoot?: (params: PrRequest) => Promise<string | null>;
  resolveGitContext?: (params: PrRequest) => Promise<CheckoutFixture | null>;
};

export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestUrl(input: RequestInfo | URL | undefined): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
}

export function routedFetch(
  routes: Array<{ match: string; response: () => Response | Promise<Response> }>,
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    return route.response();
  });
}

export function pullListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 103469,
    title: "fix(macos): tighten the link-browser tab header",
    html_url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}

export const testGitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};

const releases = new WeakMap<PreparedRepositorySessionRead, () => void>();
const retained = new Set<() => void>();
const preparedByKey = new Map<string, PreparedRepositorySessionRead>();
const checkoutByKey = new Map<string, CheckoutFixture | null>();
let service:
  | Promise<Awaited<ReturnType<typeof createTestControlUiSessionPrSubscriptions>>>
  | undefined;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let clockNow = 0;
const keyFor = (query: { sessionKey: string; agentId?: string }) =>
  JSON.stringify([query.agentId ?? "main", query.sessionKey]);
async function getService(read?: PreparedRepositorySessionRead) {
  if (!service) {
    clockNow = Date.now();
    clock = createGatewaySchedulerClock(clockNow);
    service = (async () => {
      const current = await createTestControlUiSessionPrSubscriptions({
        scheduler: createTestGatewayScheduler(clock.clock),
        getConfig: getRuntimeConfig,
        getSessionRowProjection: () => getSessionRowProjection(context),
        prepareRead: async (_connId, query) => async () => preparedByKey.get(keyFor(query)),
        readCheckoutFacts: async (observation, native, refresh) => {
          const key = keyFor(observation.session);
          return checkoutByKey.has(key)
            ? checkoutFacts(checkoutByKey.get(key) ?? null)
            : native.readCheckoutFacts(refresh);
        },
        broadcastToConnIds: vi.fn(),
      });
      const context = current.context;
      await initializeSessionReadContext(context);
      return current;
    })();
    onTestFinished(stopTestSessionPrService);
  }
  const owner = await service;
  if (read) {
    const projection = getSessionRowProjection(owner.context);
    if (!projection) {
      throw new Error("Missing native session-row projection");
    }
    await withReadySessionRows(
      projection,
      () => [{ key: read.session.sessionKey, agentId: read.session.agentId }],
      () => {},
    );
  }
  return owner;
}
export async function stopTestSessionPrService() {
  const current = service;
  service = undefined;
  await (await current)?.stop();
  preparedByKey.clear();
  checkoutByKey.clear();
}
afterEach(async () => {
  await stopTestSessionPrService();
  for (const release of retained) {
    release();
  }
  retained.clear();
});

export function localPrGitReads(type?: string) {
  return vi
    .mocked(runGitWorkerOperation)
    .mock.calls.filter(
      ([operation]) =>
        (!type || operation.type === type) &&
        operation.type !== "checkout.revision" &&
        operation.type !== "pull-request.branch-comparison",
    );
}

export function mockPrCheckout(options: {
  revision: () => string | null;
  resolve?: (root: string) => RawGitCheckoutContext | null;
  additions?: (root: string) => number;
  emptyFacts?: boolean;
}) {
  vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
    switch (operation.type) {
      case "pull-request.branch-comparison":
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      case "checkout.revision": {
        const key = options.revision();
        return key === null ? null : { key };
      }
      case "checkout.context":
        if (options.resolve) {
          return options.resolve(operation.input.root);
        }
        break;
      case "pull-request.branch-facts": {
        if (options.emptyFacts && !options.additions) {
          return undefined;
        }
        const additions = options.additions?.(operation.input.root);
        return {
          creatable: true,
          stats: additions === undefined ? null : { additions, deletions: 0, changedFiles: 1 },
        };
      }
      default:
        break;
    }
    throw new Error("Unexpected local Git operation");
  });
}

function checkoutFacts(
  context: CheckoutFixture | null,
): Awaited<ReturnType<RepositorySessionSourceScope["readCheckoutFacts"]>> {
  return context
    ? {
        originUrl: `https://${context.host ?? "github.com"}/${context.owner}/${context.repo}`,
        branch: context.branch,
        ...(context.root ? { root: context.root } : {}),
        ...(context.defaultBranch ? { defaultBranch: context.defaultBranch } : {}),
        ...(context.forkHeadCandidates ? { forkHeadCandidates: context.forkHeadCandidates } : {}),
      }
    : undefined;
}

/** Override only native checkout facts; session and physical-source ownership remain real. */
export function withTestSessionPrCheckout(
  native: PreparedRepositorySessionRead,
  context: CheckoutFixture | null,
): PreparedRepositorySessionRead {
  return {
    ...native,
    ...(context ? {} : { source: null }),
    withSource: (operation) =>
      native.withSource((scope) =>
        operation({
          ...scope,
          readCheckoutFacts: async () => checkoutFacts(context),
        }),
      ),
  };
}

/** Read the actual registered presentation with native session/source authority. */
export async function loadTestSessionPullRequests(params: PrRequest, deps: PrDeps = {}) {
  const { agentId } = resolveSessionPrFixtureRequest(params);
  const requestedContext = await deps.resolveGitContext?.(params);
  const root = deps.resolveGitRoot ? await deps.resolveGitRoot(params) : requestedContext?.root;
  if (typeof root === "string") {
    await recordSessionPrFixtureCheckout({ ...params, agentId }, root);
  }
  const prepared = await prepareSessionPrFixtureRead({ ...params, agentId });
  if (!prepared) {
    return { pullRequests: [], rateLimited: false, status: "ready" as const };
  }
  const read = deps.resolveGitContext
    ? withTestSessionPrCheckout(prepared.read, requestedContext ?? null)
    : root === null
      ? { ...prepared.read, source: null }
      : prepared.read;
  const key = keyFor(read.session);
  if (deps.resolveGitContext) {
    checkoutByKey.set(key, requestedContext ?? null);
  } else {
    checkoutByKey.delete(key);
  }
  preparedByKey.set(key, read);
  const owner = await getService(read);
  try {
    if (params.refresh) {
      // Exercise the public forced-refresh operation at its supported cadence.
      clock.setTime((clockNow += 10_001));
      await owner.replace(
        keyFor(read.session),
        [read.session.sessionKey],
        new Set([read.session.sessionKey]),
      );
    }
    return await owner.read(read, read.assertCurrent);
  } finally {
    prepared.release();
  }
}

async function prepareTestSessionPrTarget(
  params: { sessionKey: string; agentId?: string },
  context?: CheckoutFixture,
) {
  const prepared = await prepareSessionPrFixtureRead(params);
  if (!prepared) {
    return undefined;
  }
  const read = context ? withTestSessionPrCheckout(prepared.read, context) : prepared.read;
  const key = keyFor(read.session);
  if (context) {
    checkoutByKey.set(key, context);
  } else {
    checkoutByKey.delete(key);
  }
  preparedByKey.set(key, read);
  (await getService(read)).retainRead(read);
  releases.set(read, prepared.release);
  retained.add(prepared.release);
  return read;
}

/** Git/network fixtures still select real sessions; each test owns its cache namespace. */
export function createSessionPullRequestsFixture() {
  let state: OpenClawTestState | undefined;
  let cfg: OpenClawConfig;
  const seeded = new Set<string>();
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    seeded.clear();
    // Prepare fresh rows before fake clocks or concurrent reads; maintenance must not age them out.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main" },
      { sessionId: randomUUID(), updatedAt: Date.now() },
    );
    seeded.add("agent:main:main");
  });
  afterEach(async () => {
    vi.useRealTimers();
    await stopTestSessionPrService();
    await state?.cleanup();
    state = undefined;
  });
  const seed = (params: PrRequest) => {
    if (!state) {
      throw new Error("Session PR fixture is not active");
    }
    const { sessionKey, agentId } = resolveSessionPrFixtureRequest(params, cfg);
    if (!seeded.has(sessionKey)) {
      replaceSessionEntrySync(
        { agentId, sessionKey },
        { sessionId: randomUUID(), updatedAt: Date.now() },
      );
      seeded.add(sessionKey);
    }
    return { sessionKey, agentId };
  };
  return {
    load: (params: PrRequest, deps?: PrDeps) => {
      seed(params);
      return loadTestSessionPullRequests(params, deps);
    },
    presentation: getService,
    prepareRead: async (_connId: string, session: PrRequest, context?: CheckoutFixture) => {
      const params = seed(session);
      return () => prepareTestSessionPrTarget(params, context);
    },
  };
}
