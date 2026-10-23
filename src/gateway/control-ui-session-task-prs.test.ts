import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as gitReads from "../infra/git-read-cache.js";
import { publicationRowDefaults } from "../state/github-publication-fixtures.test-support.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { prepareControlUiSessionPrServiceTarget } from "./control-ui-session-pr-read.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";
import { selectTaskPublicationSessions } from "./control-ui-session-task-prs.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { insertRepositoryGitHubPublicationFixture } from "./github-publication-store.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";
import { handleGatewayRequest } from "./server-methods.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import * as records from "./session-row-projection-record.js";

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createFixture("operator.read", true);
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
  await fixture.close();
  await state.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function receipt(
  key: string,
  number: number,
  id = key + "-" + number,
  patch: Partial<RepositoryGitHubPublicationRow> = {},
) {
  const row: RepositoryGitHubPublicationRow = {
    ...publicationRowDefaults(id),
    session_key: key,
    session_id:
      key === sessionKey ? fixture.sessionId : key + "-" + fixture.sessionId.split("-").at(-1),
    session_lifecycle_revision: null,
    requester_authority_json: null,
    workspace_id: "workspace-" + id,
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-configured",
    identity_profile_id: "fixture-profile",
    previous_head_commit: null,
    pushed_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: null,
    checkpoint_digest: null,
    status: "published",
    pull_request_url: "https://github.com/example/repository/pull/" + number,
    ...patch,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  insertRepositoryGitHubPublicationFixture(row, () => {});
}
function snapshots(socket = fixture.socket): ControlUiSessionPullRequestSnapshot[] {
  return socket.send.mock.calls
    .map(([raw]) => JSON.parse(String(raw)))
    .filter((frame) => frame.event === "controlUi.sessionPullRequests.changed")
    .map((frame) => frame.payload.sessions[sessionKey]);
}
const latest = () => snapshots().at(-1);
const taskNumbers = () => latest()?.taskPullRequests?.map((pr) => pr.number);
function closedPull(number: number) {
  return pullListItem({
    number,
    state: "closed",
    html_url: "https://github.com/example/repository/pull/" + number,
    base: { repo: { name: "repository", owner: { login: "example" } } },
  });
}
function stubGitHub(branchPull = closedPull(40)) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    return githubJson(
      url.includes("?head=")
        ? [branchPull]
        : closedPull(Number(new URL(url).pathname.split("/").at(-1)) || 40),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function stubOffline(message = "offline") {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error(message);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("shares lineage work across audiences without sharing visibility or stale descendants", async () => {
  const child = "agent:main:a-child";
  const hidden = "agent:main:b-hidden";
  const leaf = "agent:main:c-leaf";
  const privateChild = "agent:main:d-private";
  await fixture.seed(child, fixture.profile.id, { parentSessionKey: sessionKey });
  await fixture.seed(hidden, fixture.other.id, {
    parentSessionKey: sessionKey,
    visibility: "draft",
  });
  await fixture.seed(leaf, fixture.profile.id, { parentSessionKey: child });
  await fixture.seed(privateChild, fixture.profile.id, {
    parentSessionKey: sessionKey,
    incognito: true,
  });
  const projection = getSessionRowProjection(fixture.context)!;
  await projection.ensureMaterialized();
  const root = projection.describe({ agentId: "main", key: sessionKey })!;
  const reads = vi.spyOn(projection, "selectEntries");
  const resolveParent = vi.spyOn(records, "parentReference");
  const expected = (keys: string[]) =>
    keys.map((key) => ({
      agentId: "main",
      sessionKey: key,
      sessionId:
        key === sessionKey ? fixture.sessionId : key + "-" + fixture.sessionId.split("-").at(-1),
      lifecycleRevision: null,
    }));
  const allowsAll = () => true;
  const allowsShared = (row: { key: string }) => row.key !== hidden;
  expect(selectTaskPublicationSessions(projection, root, allowsAll)).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );
  const firstReads = reads.mock.calls.length;
  expect(firstReads).toBeGreaterThan(0);
  expect(selectTaskPublicationSessions(projection, root, allowsShared)).toEqual(
    expected([child, leaf, sessionKey]),
  );
  expect(selectTaskPublicationSessions(projection, root, allowsAll)).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );
  expect(reads).toHaveBeenCalledTimes(firstReads);
  expect(resolveParent).not.toHaveBeenCalled();

  await fixture.seed(leaf, fixture.profile.id, { parentSessionKey: hidden, updatedAt: 2 });
  await projection.ensureMaterialized();
  const current = projection.describe({ agentId: "main", key: sessionKey })!;
  resolveParent.mockClear();
  expect(selectTaskPublicationSessions(projection, current, allowsShared)).toEqual(
    expected([child, sessionKey]),
  );
  expect(selectTaskPublicationSessions(projection, current, allowsAll)).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );
  expect(reads.mock.calls.length).toBeGreaterThan(firstReads);
  expect(resolveParent).not.toHaveBeenCalled();

  const runId = "task-pr-registry-lineage";
  subagentRuns.set(
    runId,
    createSubagentRunRecord({
      runId,
      childSessionKey: leaf,
      requesterSessionKey: child,
      controllerSessionKey: child,
      expectsCompletionMessage: false,
    }),
  );
  try {
    publishSubagentRunChanges();
    // No intervening describe/read may prepare the registry's deferred parent indexes.
    expect(selectTaskPublicationSessions(projection, current, allowsShared)).toEqual(
      expected([child, leaf, sessionKey]),
    );
  } finally {
    subagentRuns.delete(runId);
    publishSubagentRunChanges();
  }
  expect(selectTaskPublicationSessions(projection, current, allowsShared)).toEqual(
    expected([child, sessionKey]),
  );
});

it("projects three descendant receipts without mixing the parent's current branch", async () => {
  await fixture.seedRepository();
  for (let number = 1; number <= 3; number++) {
    const key = "agent:main:child-" + number;
    await fixture.seed(key, fixture.profile.id, { parentSessionKey: sessionKey });
    receipt(key, number);
  }
  receipt("agent:main:child-1", 1, "duplicate");
  const fetcher = stubGitHub(pullListItem({ number: 40, state: "closed" }));
  await fixture.subscribe();
  await fixture.subscriptions.pollNow();
  expect(latest()).toMatchObject({
    pullRequests: [{ number: 40 }],
    taskPullRequestCount: 3,
  });
  expect(taskNumbers()?.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
  const sharedTarget = await prepareControlUiSessionPrServiceTarget(
    () => getSessionRowProjection(fixture.context),
    { sessionKey, agentId: "main" },
  );
  expect(sharedTarget).toBeDefined();
  const shared = fixture.subscriptions.readPrepared(sharedTarget!, () => false);
  expect(shared).toMatchObject({ status: "ready", pullRequests: [{ number: 40 }] });
  expect(shared?.taskPullRequests).toBeUndefined();
  expect(shared?.taskPullRequestCount).toBeUndefined();
  expect(shared?.pullRequestCount).toBeUndefined();
  const calls = fetcher.mock.calls.length;
  await fixture.subscriptions.pollNow();
  expect(fetcher).toHaveBeenCalledTimes(calls);

  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100_000);
  fetcher.mockImplementation(async () => {
    throw new Error("offline");
  });
  await fixture.subscriptions.pollNow();
  expect(latest()).toMatchObject({ status: "unavailable", taskPullRequestCount: 3 });
  expect(latest()?.taskPullRequests?.every((pr) => pr.pullRequest?.state === "closed")).toBe(true);
});

async function passive(client = fixture.client) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "passive",
      method: "controlUi.sessionPullRequests.subscribe",
      params: { sessionKeys: [], passiveSessionKeys: [sessionKey] },
    },
    client,
    context: fixture.context,
    isWebchatConnect: () => false,
    respond,
  });
  expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
  await fixture.subscriptions.pollNow();
}

it("reads own and nested receipts without a checkout, refreshes on commit, and never polls GitHub", async () => {
  const child = "agent:main:child";
  const grandchild = "agent:main:grandchild";
  await fixture.seed(child, fixture.profile.id, { parentSessionKey: sessionKey });
  await fixture.seed(grandchild, fixture.profile.id, { parentSessionKey: child });
  receipt(sessionKey, 1);
  receipt(grandchild, 2);
  const fetcher = stubOffline("No GitHub allowed for passive rows");
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  await passive();
  expect(latest()).toMatchObject({
    branchRead: false,
    pullRequests: [],
    taskPullRequestCount: 2,
  });
  expect(latest()?.pullRequestCount).toBeUndefined();
  expect(latest()?.taskPullRequests?.every((pr) => !pr.pullRequest)).toBe(true);
  const work = reads.mock.calls.filter(
    ([, command]) => command.type === "githubPublications.taskReceipts",
  ).length;
  expect(work).toBe(1);
  await fixture.subscriptions.pollNow();
  expect(
    reads.mock.calls.filter(([, command]) => command.type === "githubPublications.taskReceipts"),
  ).toHaveLength(work);
  receipt(child, 3);
  await vi.waitFor(() => expect(latest()?.taskPullRequestCount).toBe(3));
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])(
  "counts branch PRs beyond the receipt preview (passive=%s)",
  async (watchPassively) => {
    await fixture.seedRepository();
    for (let number = 1; number <= 25; number++) {
      receipt(sessionKey, number);
    }
    const fetcher = stubGitHub();
    await fixture.subscribe();
    await fixture.subscriptions.pollNow();
    const active = latest();
    expect(active).toMatchObject({
      pullRequests: [{ number: 40 }],
      taskPullRequestCount: 25,
      pullRequestCount: 26,
    });
    expect(active?.taskPullRequests).toHaveLength(20);
    const git = vi.spyOn(gitReads, "runGitReadOperation");
    const networkCalls = fetcher.mock.calls.length;
    if (watchPassively) {
      // Another browser may already retain this profile's passive audience cell.
      await passive(fixture.addReader("passive-peer").client);
      await passive();
      expect(latest()).toMatchObject({
        branchRead: false,
        pullRequests: active?.pullRequests,
        repository: active?.repository,
        taskPullRequestCount: 25,
        pullRequestCount: 26,
      });
    }
    // This overlap is outside the preview: counting only visible URLs is incorrect.
    receipt(sessionKey, 40, "passive-overlap", { updated_at_ms: 1 });
    await vi.waitFor(() =>
      expect(latest()).toMatchObject({
        ...(watchPassively ? { branchRead: false } : {}),
        taskPullRequestCount: 26,
        pullRequestCount: 26,
      }),
    );
    expect(taskNumbers()?.includes(40)).toBe(false);
    if (watchPassively) {
      await fixture.subscriptions.pollNow();
      expect(git).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(networkCalls);
    }
  },
);

it("keeps personal receipts viewer-scoped and withdraws inaccessible descendants", async () => {
  const child = "agent:main:private-child";
  await fixture.seed(child, fixture.other.id, {
    parentSessionKey: sessionKey,
    visibility: "shared",
  });
  receipt(child, 1);
  receipt(sessionKey, 2, "personal", {
    owner_profile_id: fixture.profile.id,
    identity_source: "personal",
    connection_generation: "personal-generation",
  });
  const incognito = "agent:main:incognito-child";
  await fixture.seed(incognito, fixture.profile.id, {
    parentSessionKey: sessionKey,
    incognito: true,
  });
  receipt(incognito, 3);
  const childReceipt = {
    url: "https://github.com/example/repository/pull/1",
    owner: "example",
    repo: "repository",
    number: 1,
    branch: "openclaw/worker-proof",
    sourceSessionKey: child,
    sourceAgentId: "main",
  };
  const personalReceipt = {
    ...childReceipt,
    url: "https://github.com/example/repository/pull/2",
    number: 2,
    sourceSessionKey: sessionKey,
  };
  const expectedSnapshot = {
    pullRequests: [],
    rateLimited: false,
    taskPullRequests: [personalReceipt, childReceipt],
    taskPullRequestCount: 2,
    branchRead: false,
    status: "ready",
  };
  stubOffline();
  await passive();
  expect(latest()).toEqual(expectedSnapshot);
  const other = fixture.addReader("other-viewer");
  other.client.authenticatedUserProfile = {
    ...other.client.authenticatedUserProfile!,
    profileId: fixture.other.id,
  };
  prepareGatewayRecipientProfile(other.client);
  await passive(other.client);
  expect(snapshots(other.socket).at(-1)).toEqual({
    ...expectedSnapshot,
    taskPullRequests: [childReceipt],
    taskPullRequestCount: 1,
  });
  await fixture.seed(child, fixture.other.id, {
    parentSessionKey: sessionKey,
    visibility: "draft",
    updatedAt: 2,
  });
  await fixture.subscriptions.pollNow();
  await vi.waitFor(() =>
    expect(latest()).toEqual({
      ...expectedSnapshot,
      taskPullRequests: [personalReceipt],
      taskPullRequestCount: 1,
    }),
  );
  await fixture.changeReader("grant");
  const delivered = snapshots().length;
  receipt(sessionKey, 3);
  await fixture.subscriptions.pollNow();
  expect(snapshots()).toHaveLength(delivered);
});

it("keeps a known cold URL when GitHub metadata fails, and ignores a replaced session lifecycle", async () => {
  receipt(sessionKey, 1);
  stubOffline();
  await fixture.subscribe();
  await fixture.subscriptions.pollNow();
  expect(latest()).toMatchObject({
    status: "unavailable",
    taskPullRequestCount: 1,
    taskPullRequests: [{ url: "https://github.com/example/repository/pull/1" }],
  });
  expect(latest()?.taskPullRequests?.[0]?.pullRequest).toBeUndefined();
  await fixture.seed(sessionKey, fixture.profile.id, {
    sessionId: "replacement",
    lifecycleRevision: "replacement-revision",
    updatedAt: 2,
  });
  await fixture.subscriptions.pollNow();
  await vi.waitFor(() => expect(latest()?.taskPullRequestCount).toBe(0));
});
