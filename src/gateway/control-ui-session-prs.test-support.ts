// Shared fixtures for the control-ui session PR tests; test-only module.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import {
  repositorySessionPrTarget,
  type ControlUiSessionPrTarget,
  type ControlUiSessionPrReadContext,
} from "../../extensions/github-repositories/control-ui-session-pr-read-api.js";
import type { GitHubCheckoutContext as GitCheckoutContext } from "../../extensions/github-repositories/control-ui-session-prs-api.js";
import { loadControlUiSessionPullRequests as loadPrs } from "../../extensions/github-repositories/control-ui-session-prs-api.js";
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
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  prepareSessionPrFixtureRead,
  recordSessionPrFixtureCheckout,
  resolveSessionPrFixtureRequest,
} from "./control-ui-session-pr-access.test-support.js";

type PrRequest = Parameters<typeof loadPrs>[0];
type PrDeps = Omit<Parameters<typeof loadPrs>[1], "read"> & {
  resolveGitRoot?: (params: PrRequest) => Promise<string | null>;
  resolveGitContext?: (params: PrRequest) => Promise<GitCheckoutContext | null>;
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

const releases = new WeakMap<ControlUiSessionPrTarget, () => void>();
const retained = new Set<() => void>();
afterEach(() => {
  for (const release of retained) {
    release();
  }
  retained.clear();
});

/** The loader fixture retains the same real session/source owner as production. */
export function withTestSessionPrRead<T>(
  target: ControlUiSessionPrTarget,
  operation: (read: ControlUiSessionPrReadContext) => Promise<T>,
): Promise<T> {
  if (!target.read) {
    throw new Error("Missing prepared fixture read");
  }
  return target.read.withSource((sourceScope) =>
    operation({
      target,
      sourceScope,
      sourceIdentity: sourceScope.identity,
      assertCurrent: sourceScope.assertCurrent,
    }),
  );
}

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

/** Direct loader tests supply real target facts; registered callers use the row projection. */
export async function loadTestSessionPullRequests(
  params: PrRequest,
  deps: PrDeps = {},
): ReturnType<typeof loadPrs> {
  const { agentId } = resolveSessionPrFixtureRequest(params);
  const { resolveGitRoot, resolveGitContext, ...ownerDeps } = deps;
  const requestedContext = await resolveGitContext?.(params);
  const root = resolveGitRoot ? await resolveGitRoot(params) : requestedContext?.root;
  if (typeof root === "string") {
    // A requested test checkout is recorded on the real session, not selected by a runtime hook.
    await recordSessionPrFixtureCheckout({ ...params, agentId }, root);
  }
  const target = await prepareTestSessionPrTarget({ ...params, agentId });
  if (!target) {
    return { pullRequests: [], rateLimited: false };
  }
  try {
    const source = resolveGitContext
      ? (requestedContext ?? null)
      : root === null
        ? null
        : target.source;
    return await withTestSessionPrRead({ ...target, source }, (read) =>
      loadPrs(params, { ...ownerDeps, read }),
    );
  } finally {
    const release = releases.get(target);
    release?.();
    if (release) {
      retained.delete(release);
    }
  }
}

async function prepareTestSessionPrTarget(params: { sessionKey: string; agentId?: string }) {
  const prepared = await prepareSessionPrFixtureRead(params);
  if (!prepared) {
    return undefined;
  }
  const target = repositorySessionPrTarget(prepared.read, getRuntimeConfig(), prepared.read);
  releases.set(target, prepared.release);
  retained.add(prepared.release);
  return target;
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
    prepareRead: async (_connId: string, session: PrRequest) => {
      const params = seed(session);
      return () => prepareTestSessionPrTarget(params);
    },
  };
}
