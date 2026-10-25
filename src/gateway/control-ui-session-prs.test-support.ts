// Shared fixtures for the control-ui session PR tests; test-only module.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { loadControlUiSessionPullRequests as loadPrs } from "./control-ui-session-prs.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnlyAsync as loadEntry } from "./session-utils-store.js";

type PrRequest = Parameters<typeof loadPrs>[0];
type PrDeps = Omit<Parameters<typeof loadPrs>[1], "read"> & {
  resolveGitRoot?: (params: PrRequest) => Promise<string | null>;
  resolveGitContext?: (params: PrRequest) => Promise<GitCheckoutContext | null>;
};

function requestAgent(params: PrRequest, cfg = getRuntimeConfig()) {
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    throw new Error(requested.error.message);
  }
  return requested.agentId;
}

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
  resolve?: (root: string) => GitCheckoutContext | null;
  additions?: (root: string) => number;
  emptyFacts?: boolean;
}) {
  vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
    switch (operation.type) {
      case "pull-request.branch-comparison":
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      case "checkout.revision":
        return options.revision();
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

/** Direct loader tests supply real target facts; registered callers use the row projection. */
export async function loadTestSessionPullRequests(
  params: PrRequest,
  deps: PrDeps = {},
): ReturnType<typeof loadPrs> {
  const agentId = requestAgent(params);
  const target = await prepareTestSessionPrTarget({ ...params, agentId });
  if (!target) {
    return { pullRequests: [], rateLimited: false };
  }
  const facts = await prepareSessionMutationFacts({
    cfg: getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId,
  });
  try {
    const original = facts.readCurrent(getRuntimeConfig()).target.entry;
    return await withControlUiSessionPrSource(
      target.readSource,
      async (assertSourceCurrent, sourceIdentity) => {
        const assertCurrent = () => {
          assertSourceCurrent();
          const current = facts.readCurrent(getRuntimeConfig()).target.entry;
          if (
            current.sessionId !== original.sessionId ||
            current.lifecycleRevision !== original.lifecycleRevision
          ) {
            throw new Error("Session pull-request target changed");
          }
        };
        const { resolveGitRoot, resolveGitContext, ...ownerDeps } = deps;
        const request = { ...params, ...target.params };
        assertCurrent();
        const source = resolveGitContext
          ? await resolveGitContext(request)
          : resolveGitRoot
            ? await resolveGitRoot(request)
            : target.source;
        assertCurrent();
        return loadPrs(params, {
          ...ownerDeps,
          read: { target: { ...target, source }, sourceIdentity, assertCurrent },
        });
      },
    );
  } finally {
    facts.release();
  }
}

async function prepareTestSessionPrTarget(params: { sessionKey: string; agentId?: string }) {
  const read = () => loadEntry(params.sessionKey, { agentId: params.agentId });
  const initial = await read();
  const prepared = initial.entry?.repositoryWorkspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(initial.entry.repositoryWorkspaceId)
    : undefined;
  const selected = await read();
  const repository = prepared?.current();
  return resolveControlUiSessionPrTarget(
    selected,
    repository?.workspaceId === selected.entry?.repositoryWorkspaceId &&
      repository?.agentId === selected.agentId &&
      repository.sessionKey === selected.canonicalKey
      ? repository
      : null,
    { includeBoundPullRequest: true },
  );
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
    // Prepare the canonical store before tests install fake clocks or concurrent reads.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main" },
      { sessionId: randomUUID(), updatedAt: 1 },
    );
    seeded.add("agent:main:main");
  });
  afterEach(async () => {
    vi.useRealTimers();
    await state?.cleanup();
    state = undefined;
  });
  const seed = (params: PrRequest) => {
    if (!state) {
      throw new Error("Session PR fixture is not active");
    }
    const agentId = requestAgent(params, cfg);
    const sessionKey = resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: agentId,
    });
    if (!seeded.has(sessionKey)) {
      replaceSessionEntrySync({ agentId, sessionKey }, { sessionId: randomUUID(), updatedAt: 1 });
      seeded.add(sessionKey);
    }
    return { sessionKey, agentId };
  };
  return {
    load: (params: PrRequest, deps?: PrDeps) => {
      seed(params);
      return loadTestSessionPullRequests(params, deps);
    },
    prepareRead: async (_connId: string, session: PrRequest) => {
      const params = seed(session);
      return () => prepareTestSessionPrTarget(params);
    },
  };
}
