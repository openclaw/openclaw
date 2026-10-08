import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareGitHubReadIdentity } from "../agents/github-tool-identity.js";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  requestUrl,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";

vi.mock("../infra/git-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/git-worker.js")>()),
  runGitWorkerOperation: vi.fn(),
}));
vi.mock("../agents/github-tool-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/github-tool-identity.js")>()),
  prepareGitHubReadIdentity: vi.fn(),
}));

const { load } = createSessionPullRequestsFixture();
const HEAD = "a".repeat(40);
const LANDED = "b".repeat(40);
const TOKEN = "selected-agent-test-credential";
const context = { ...testGitContext, root: "/session-checkout" };
let raw: string | null;
let uuid: string;
let outcome: "pending" | "merged" | "enqueued" | "failed";
let apiStatus: number;
let currentIdentity: boolean;

function record() {
  return JSON.stringify({
    version: 1,
    pr: 103469,
    head: HEAD,
    repo: { nameWithOwner: "openclaw/openclaw", url: "https://github.com/openclaw/openclaw" },
    transport: "rest",
    route: "immediate",
    method: "squash",
    accepted: true,
    phase: "intent",
    asyncMerge: { uuid, status: "pending", message: "Merge accepted", sha: null },
  });
}

function network() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.pathname.includes("/merge-async/")) {
      return apiStatus === 200
        ? githubJson({
            status: outcome,
            details:
              outcome === "merged"
                ? { sha: LANDED, message: "Merged" }
                : {
                    uuid,
                    expected_head_sha: HEAD,
                    merge_method: "squash",
                    merge_action: "direct_merge",
                    message: "Merging",
                  },
          })
        : new Response(JSON.stringify({ message: "Status unavailable" }), {
            status: apiStatus,
            headers: { "retry-after": "120" },
          });
    }
    if (url.pathname.endsWith("/pulls")) {
      return githubJson([
        pullListItem(
          outcome === "merged"
            ? { state: "closed", merged_at: "2026-10-08T17:00:00Z", merge_commit_sha: LANDED }
            : {},
        ),
      ]);
    }
    if (url.pathname.endsWith("/check-runs")) {
      return githubJson({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "success" }],
      });
    }
    if (url.pathname.endsWith("/pulls/103469")) {
      return githubJson({ additions: 4, deletions: 3 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

beforeEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  vi.mocked(prepareGitHubReadIdentity).mockReset();
  raw = null;
  uuid = randomUUID();
  outcome = "pending";
  apiStatus = 200;
  currentIdentity = true;
  vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) =>
    operation.type === "repository.ref-file" ? raw : undefined,
  );
  vi.mocked(prepareGitHubReadIdentity).mockImplementation(async (params) => {
    const assertSelected = () => {
      params.assertActive();
      if (!currentIdentity) {
        throw new Error("Identity retired");
      }
    };
    return {
      token: TOKEN,
      cacheScope: uuid,
      selection: { source: "agent-override", profileId: "agent-github", accountId: 42 },
      assertSelected,
      revalidate: async () => assertSelected(),
      start: (start) => {
        assertSelected();
        return Promise.resolve(start());
      },
    };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("session async merge observation", () => {
  it("discovers a receipt without refetching CI, then confirms completion through the canonical PR loader", async () => {
    const fetchImpl = network();
    const read = () =>
      load(
        { sessionKey: "agent:main:merge" },
        { resolveGitContext: async () => context, fetchImpl },
      );
    expect((await read()).pullRequests[0]?.merge).toBeUndefined();
    raw = record();
    const pending = await read();
    expect(pending.pullRequests[0]).toMatchObject({
      merge: { status: "pending", message: "Merging" },
      checks: { passed: 1 },
    });
    const request = fetchImpl.mock.calls.find(([input]) =>
      requestUrl(input).includes("/merge-async/"),
    );
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/check-runs")),
    ).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
    outcome = "merged";
    const completed = await read();
    expect(completed.pullRequests[0]).toMatchObject({ state: "merged" });
    expect(completed.pullRequests[0]?.merge).toBeUndefined();
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/check-runs")),
    ).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        new URL(requestUrl(input)).pathname.endsWith("/pulls"),
      ),
    ).toHaveLength(2);
  });

  it("drops pending on quota failure, retains retry backoff, and revalidates cached delivery", async () => {
    raw = record();
    const fetchImpl = network();
    const read = () =>
      load(
        { sessionKey: "agent:main:quota" },
        { resolveGitContext: async () => context, fetchImpl },
      );
    expect((await read()).pullRequests[0]?.merge?.status).toBe("pending");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
    apiStatus = 429;
    expect((await read()).pullRequests[0]?.merge).toMatchObject({
      status: "unavailable",
      retryAfterMs: 120_000,
    });
    clock.mockReturnValue(Date.now() + 60_000);
    await read();
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/merge-async/")),
    ).toHaveLength(2);
    currentIdentity = false;
    expect((await read()).pullRequests[0]?.merge?.status).toBe("unavailable");
  });

  it.each(["enqueued", "failed"] as const)(
    "retains %s without polling a completed request again",
    async (terminal) => {
      raw = record();
      outcome = terminal;
      const fetchImpl = network();
      const read = () =>
        load(
          { sessionKey: `agent:main:terminal-${terminal}` },
          { resolveGitContext: async () => context, fetchImpl },
        );
      expect((await read()).pullRequests[0]?.merge?.status).toBe(terminal);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60_000);
      apiStatus = 404;
      expect((await read()).pullRequests[0]?.merge?.status).toBe(terminal);
      expect(
        fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/merge-async/")),
      ).toHaveLength(1);
      currentIdentity = false;
      expect((await read()).pullRequests[0]?.merge?.status).toBe("unavailable");
    },
  );

  it("refreshes pending observations after a backward wall-clock adjustment", async () => {
    raw = record();
    const fetchImpl = network();
    const read = () =>
      load(
        { sessionKey: "agent:main:clock" },
        { resolveGitContext: async () => context, fetchImpl },
      );
    expect((await read()).pullRequests[0]?.merge?.status).toBe("pending");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5_001);
    outcome = "failed";
    expect((await read()).pullRequests[0]?.merge?.status).toBe("failed");
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).includes("/merge-async/")),
    ).toHaveLength(2);
  });

  it("keeps a terminal observation when an older pending read completes afterward", async () => {
    raw = record();
    const entered = createDeferred();
    const held = createDeferred();
    const underlying = network();
    let mergeReads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (...args) => {
      const response = await underlying(...args);
      if (requestUrl(args[0]).includes("/merge-async/") && ++mergeReads === 1) {
        entered.resolve();
        await held.promise;
      }
      return response;
    });
    const read = () =>
      load(
        { sessionKey: "agent:main:overlap" },
        { resolveGitContext: async () => context, fetchImpl },
      );
    const older = read();
    try {
      await entered.promise;
      outcome = "enqueued";
      expect((await read()).pullRequests[0]?.merge?.status).toBe("enqueued");
      held.resolve();
      expect((await older).pullRequests[0]?.merge?.status).toBe("enqueued");
      apiStatus = 404;
      expect((await read()).pullRequests[0]?.merge?.status).toBe("enqueued");
      expect(mergeReads).toBe(2);
    } finally {
      held.resolve();
      await older;
    }
  });

  it("does not discover or invent tracking IDs for a remote-only workspace", async () => {
    raw = record();
    const result = await load(
      { sessionKey: "agent:main:remote" },
      { resolveGitContext: async () => testGitContext, fetchImpl: network() },
    );
    expect(result.pullRequests[0]?.merge).toBeUndefined();
    expect(runGitWorkerOperation).not.toHaveBeenCalled();
    expect(prepareGitHubReadIdentity).not.toHaveBeenCalled();
  });
});
