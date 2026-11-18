import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  listAgentDatabaseAdmissionRefusals,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  holdStateRead,
  publicationRowDefaults,
  waitForPublicationGate,
} from "../state/github-publication-fixtures.test-support.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { mergeProfiles } from "../state/user-profile-writes.worker.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPullRequestSnapshot } from "./control-ui-contract.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { createControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { prepareTaskPublicationSessions } from "./control-ui-session-task-prs.js";
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
function stubOffline(message = "offline") {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error(message);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("reuses unchanged watcher currency and retires it on owner publications", async () => {
  const f = fixture;
  const child = "agent:main:currency-child";
  await f.seed(child, f.other.id, { parentSessionKey: sessionKey });
  const projection = getSessionRowProjection(f.context)!;
  const read = createControlUiSessionPrRead({
    client: f.client,
    sessionKey,
    getRuntimeConfig: f.context.getRuntimeConfig,
    getSessionRowProjection: () => projection,
    isCurrentClient: () => !f.client.invalidated,
  })!;
  const target = (await read())!;
  expect(target.taskReceipts?.sessions.map((session) => session.sessionKey)).toEqual([
    child,
    sessionKey,
  ]);
  target.assertCurrent!();
  const admissions = listAgentDatabaseAdmissionRefusals();
  try {
    recordAgentDatabaseAdmissions([
      {
        agentId: "main",
        paths: [],
        code: "agent-database-inspection-pending",
        reason: "Synthetic admission change",
        repairHint: "Wait for admission",
      },
    ]);
    expect(() => target.assertCurrent!()).toThrow("Session pull-request target changed");
    expect(await read()).toBeUndefined();
  } finally {
    recordAgentDatabaseAdmissions(admissions);
  }
  expect((await read())?.taskReceipts?.sessions.map((session) => session.sessionKey)).toEqual([
    child,
    sessionKey,
  ]);

  await f.seed(child, f.other.id, {
    parentSessionKey: sessionKey,
    visibility: "draft",
  });
  await projection.ensureMaterialized();
  expect(() => target.assertCurrent!()).toThrow("Task pull-request audience changed");
  const narrowed = (await read())!;
  expect(narrowed.taskReceipts?.sessions.map((session) => session.sessionKey)).toEqual([
    sessionKey,
  ]);

  // Publishing the same config object still advances the owner's revision.
  const cfg = f.context.getRuntimeConfig();
  cfg.gateway!.roles!.definitions.reader!.scopes = [];
  setRuntimeConfigSnapshot(cfg);
  expect(() => narrowed.assertCurrent!()).toThrow("Session pull-request target changed");
  expect(await read()).toBeUndefined();
});

it("prepares task audience policy once without reacquiring descendant membership", async () => {
  for (let index = 0; index < 4; index++) {
    await fixture.seed(`agent:main:foreign-${index}`, fixture.other.id, {
      parentSessionKey: sessionKey,
    });
  }
  const projection = getSessionRowProjection(fixture.context)!;
  const read = createControlUiSessionPrRead({
    client: fixture.client,
    sessionKey,
    getRuntimeConfig: fixture.context.getRuntimeConfig,
    getSessionRowProjection: () => projection,
    isCurrentClient: () => true,
  })!;
  const target = (await read())!;
  expect(target.taskReceipts?.sessions).toHaveLength(5);
  await fixture.seed("agent:main:unrelated", fixture.profile.id);
  await projection.ensureMaterialized();
  target.assertCurrent!();

  await fixture.seed("agent:main:foreign-0", fixture.other.id, {
    parentSessionKey: sessionKey,
    visibility: "draft",
  });
  await projection.ensureMaterialized();
  expect(() => target.assertCurrent!()).toThrow("Task pull-request audience changed");
  const narrowed = (await read())!;
  expect(narrowed.taskReceipts?.sessions).toHaveLength(4);

  // A later validation must prepare fresh aliases, even when the viewer ID is unchanged.
  mergeProfiles(fixture.other.id, fixture.profile.id);
  prepareGatewayRecipientProfile(fixture.client);
  expect(() => narrowed.assertCurrent!()).toThrow("Task pull-request audience changed");
  expect((await read())?.taskReceipts?.sessions).toHaveLength(5);
});

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
  const expected = (keys: string[]) =>
    keys.map((key) => ({
      agentId: "main",
      sessionKey: key,
      sessionId:
        key === sessionKey ? fixture.sessionId : key + "-" + fixture.sessionId.split("-").at(-1),
      lifecycleRevision: null,
    }));
  const allowsAll = () => true;
  const allowsShared = ({ key }: records.EntryRow) => key !== hidden;
  const selected = prepareTaskPublicationSessions(projection, root, () => allowsAll).sessions;
  expect(selected).toEqual(expected([child, hidden, leaf, sessionKey]));
  selected.reverse();
  expect(prepareTaskPublicationSessions(projection, root, () => allowsAll).sessions).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );
  expect(prepareTaskPublicationSessions(projection, root, () => allowsShared).sessions).toEqual(
    expected([child, leaf, sessionKey]),
  );
  expect(prepareTaskPublicationSessions(projection, root, () => allowsAll).sessions).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );

  let allows: typeof allowsShared = allowsAll;
  const retained = prepareTaskPublicationSessions(projection, root, () => allows);
  retained.assertCurrent();
  allows = allowsShared;
  expect(() => retained.assertCurrent()).toThrow("Task pull-request audience changed");
  const restricted = prepareTaskPublicationSessions(projection, root, () => allows);
  allows = allowsAll;
  expect(() => restricted.assertCurrent()).toThrow("Task pull-request audience changed");
  retained.assertCurrent();

  await fixture.seed("agent:main:unrelated", fixture.profile.id);
  await projection.ensureMaterialized();
  prepareTaskPublicationSessions(projection, root, () => allowsAll);
  await fixture.seed("agent:main:unrelated", fixture.profile.id, {
    label: "Updated",
    updatedAt: 2,
  });
  await fixture.seed(child, fixture.profile.id, { parentSessionKey: sessionKey, label: "Updated" });
  await projection.ensureMaterialized();
  expect(prepareTaskPublicationSessions(projection, root, () => allowsShared).sessions).toEqual(
    expected([child, leaf, sessionKey]),
  );
  retained.assertCurrent();

  // Permissions consume the replacement row even when lineage itself is unchanged.
  await fixture.seed(hidden, fixture.profile.id, {
    parentSessionKey: sessionKey,
    visibility: "shared",
  });
  await projection.ensureMaterialized();
  expect(
    prepareTaskPublicationSessions(
      projection,
      root,
      () =>
        ({ entry }) =>
          entry.visibility !== "draft",
    ).sessions,
  ).toEqual(expected([child, hidden, leaf, sessionKey]));

  await fixture.seed(leaf, fixture.profile.id, { parentSessionKey: hidden, updatedAt: 2 });
  await projection.ensureMaterialized();
  const current = projection.describe({ agentId: "main", key: sessionKey })!;
  expect(prepareTaskPublicationSessions(projection, current, () => allowsShared).sessions).toEqual(
    expected([child, sessionKey]),
  );
  expect(prepareTaskPublicationSessions(projection, current, () => allowsAll).sessions).toEqual(
    expected([child, hidden, leaf, sessionKey]),
  );

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
    expect(
      prepareTaskPublicationSessions(projection, current, () => allowsShared).sessions,
    ).toEqual(expected([child, leaf, sessionKey]));
  } finally {
    subagentRuns.delete(runId);
    publishSubagentRunChanges();
  }
  expect(prepareTaskPublicationSessions(projection, current, () => allowsShared).sessions).toEqual(
    expected([child, sessionKey]),
  );
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
  await passive();
  expect(latest()).toMatchObject({
    branchRead: false,
    pullRequests: [],
    taskPullRequestCount: 2,
  });
  expect(latest()?.pullRequestCount).toBeUndefined();
  expect(latest()?.taskPullRequests?.every((pr) => !pr.pullRequest)).toBe(true);
  receipt(child, 3);
  await vi.waitFor(() => expect(latest()?.taskPullRequestCount).toBe(3));
  expect(fetcher).not.toHaveBeenCalled();
});

it("withholds task receipts when a descendant becomes private during their read", async ({
  signal,
}) => {
  const child = "agent:main:pending-private-child";
  await fixture.seed(child, fixture.other.id, { parentSessionKey: sessionKey });
  receipt(child, 1);
  stubOffline();
  const held = holdStateRead("githubPublications.taskReceipts");
  const pending = passive();
  try {
    await waitForPublicationGate(signal, pending, held.ready);
    await fixture.seed(child, fixture.other.id, {
      parentSessionKey: sessionKey,
      visibility: "draft",
    });
    held.release();
    await pending;
    await fixture.subscriptions.pollNow();
    await vi.waitFor(() => expect(taskNumbers()).toEqual([]));
    expect(snapshots().flatMap((snapshot) => snapshot.taskPullRequests ?? [])).toEqual([]);
  } finally {
    held.release();
    await pending.catch(() => {});
    held.restore();
  }
});

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
