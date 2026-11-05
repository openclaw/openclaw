import { afterEach, expect, it, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetDataQuery,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { toRequestUrl } from "../../test-utils/provider-usage-fetch.js";
import { boardStore } from "../board-store.js";
import { BOARD_VIEW_TICKET_TTL_MS, createBoardViewTicket } from "../board-view-ticket.js";
import {
  authorizationClient,
  dispatchAuthorizationRequest,
} from "../server-methods.authorization.test-support.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createBoardHandlers } from "./board.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

const target = { sessionKey: "agent:main:ci-dashboard", agentId: "main" };
const html = "<p>CI</p>";
const query: BoardWidgetDataQuery = {
  name: "main-ci",
  bindingId: "github.actions.runs",
  params: {
    repository: "owner/repo",
    workflow: "ci.yml",
    branch: "main",
    status: null,
    created: null,
    perPage: 1,
    excludePullRequests: true,
  },
  fields: ["id", "conclusion"],
};
const run = {
  id: 4242,
  name: "CI",
  display_title: "Private release summary",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/4242",
  run_started_at: "2026-10-27T00:00:00Z",
  created_at: "2026-10-27T00:00:00Z",
  updated_at: "2026-10-27T00:01:00Z",
  event: "push",
  workflow_id: 17,
  run_attempt: 1,
};
const result = { total_count: 1, workflow_runs: [run] };
const projected = { workflow_runs: [{ id: 4242, conclusion: "success" }] };
const queryUrl =
  "https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?per_page=1&exclude_pull_requests=true&branch=main";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function withReader(
  exercise: (fixture: Awaited<ReturnType<typeof prepareReader>>) => Promise<void>,
  legacy = false,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prepareProfileCatalog: true,
      env: { GH_TOKEN: "synthetic-actions-token", GITHUB_TOKEN: undefined },
    },
    async () => {
      const fixture = await prepareReader(legacy);
      try {
        await exercise(fixture);
      } finally {
        await fixture.work.drain();
      }
    },
  );
}

async function prepareReader(legacy: boolean) {
  const owner = roleClient("view", "ci-owner");
  const viewer = roleClient("view", "ci-reader");
  viewer.connect.scopes = ["operator.sessions.read"];
  const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  const entry = {
    sessionId: "ci-dashboard-session",
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: owner.authenticatedUserProfile!.profileId,
    },
  };
  await upsertSessionEntryCore(target, entry);
  const initialSnapshot = await boardStore.putWidget({
    ...target,
    name: "ci",
    content: { kind: "html", html },
    declared: legacy ? { tools: ["github.actions.runs:owner/repo"] } : { queries: [query] },
  });
  const initialWidget = initialSnapshot.widgets[0]!;
  await boardStore.grant(target, "ci", "granted", initialWidget.revision, initialWidget.instanceId);
  const work = new AsyncWorkScope();
  const context = await createHistoryReadContext({
    getRuntimeConfig: () => cfg,
    trackExecution: (execute) => work.track(execute),
  });
  context.resolveGatewayContext = () => context;
  const extraHandlers = createBoardHandlers(boardStore);
  const dispatch = (method: string, params: Record<string, unknown>, client = viewer) =>
    dispatchAuthorizationRequest(method, params, { client, context, extraHandlers });
  const ticketFor = async (session = target, name = "ci", client = viewer) => {
    const board = await dispatch("board.get", session, client);
    expect(board.mock.calls[0]?.[0]).toBe(true);
    return (board.mock.calls[0]![1] as BoardSnapshot).widgets.find((item) => item.name === name)!
      .viewTicket;
  };
  const ticket = await ticketFor();
  let actions = async (_url: string) => new Response(JSON.stringify(result));
  const http = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      toRequestUrl(url).endsWith("/user")
        ? new Response(JSON.stringify({ id: 100, login: "fixture-user", avatar_url: null }))
        : actions(toRequestUrl(url)),
    );
  vi.stubGlobal("fetch", http);
  const read = (overrides: Record<string, unknown> = {}, client = viewer) =>
    dispatch("board.data.read", { ticket, queryName: "main-ci", ...overrides }, client);
  const flexibleRead = (overrides: Record<string, unknown> = {}, client = viewer) =>
    dispatch(
      "board.data.read",
      {
        ticket,
        bindingId: "github.actions.runs",
        params: { repository: "owner/repo" },
        ...overrides,
      },
      client,
    );
  const putQuery = async (name: string, definition = query, session = target) => {
    const saved = await boardStore.putWidget({
      ...session,
      name,
      content: { kind: "html", html },
      declared: { queries: [definition] },
    });
    return saved.widgets.find((item) => item.name === name)!;
  };
  const grantQuery = async (name: string, definition = query, session = target) => {
    const widget = await putQuery(name, definition, session);
    await boardStore.grant(session, name, "granted", widget.revision, widget.instanceId);
    return widget;
  };
  const signCurrentTicket = (name: string) =>
    boardStore.useWidgetDocument(target, name, (document) => {
      if (!document || !("viewGeneration" in document)) {
        throw new Error("Missing HTML widget fixture");
      }
      return createBoardViewTicket({
        ...target,
        name,
        revision: document.revision,
        viewGeneration: document.viewGeneration,
        authority: {
          gatewayContext: context,
          resolveGatewayContext: context.resolveGatewayContext!,
        },
      }).ticket;
    });
  return {
    signCurrentTicket,
    owner,
    viewer,
    entry,
    work,
    read,
    flexibleRead,
    dispatch,
    ticketFor,
    putQuery,
    grantQuery,
    setActions: (next: typeof actions) => {
      actions = next;
    },
    actionCalls: () => http.mock.calls.filter(([url]) => toRequestUrl(url).includes("/actions/")),
  };
}

async function expectDenied(
  pending: ReturnType<Awaited<ReturnType<typeof prepareReader>>["read"]>,
) {
  const response = await pending;
  expect(response.mock.calls[0]).toMatchObject([false, undefined, { message: expect.any(String) }]);
  expect(JSON.stringify(response.mock.calls)).not.toContain("synthetic-actions-token");
}

it("serves only the approved named query and fields through real session-reader admission", () =>
  withReader(async (f) => {
    expect((await f.read()).mock.calls[0]).toEqual([true, projected]);
    expect((await f.read()).mock.calls[0]).toEqual([true, projected]);
    for (const scopes of [["operator.sessions.write"], ["operator.read"]]) {
      f.viewer.connect.scopes = scopes;
      expect((await f.read()).mock.calls[0]).toEqual([true, projected]);
    }
    f.viewer.connect.scopes = ["operator.sessions.read"];
    expect(f.actionCalls()).toHaveLength(1);
    expect(toRequestUrl(f.actionCalls()[0]![0])).toBe(queryUrl);
    for (const overrides of [
      { queryName: "unknown" },
      { bindingId: "github.actions.runs" },
      { params: {} },
      { params: { repository: "owner/other" } },
      { params: { branch: "unimplemented-filter" } },
      { repository: "owner/other" },
      { workflow: "release.yml" },
      { branch: "release" },
      { status: "failure" },
      { created: ">=2026-01-01" },
      { perPage: 30 },
      { excludePullRequests: false },
      { fields: ["display_title"] },
      { sessionKey: target.sessionKey },
      { ticket: "forged" },
    ]) {
      await expectDenied(f.read(overrides));
    }
    await expectDenied(f.flexibleRead());
    for (const bindingId of ["sessions.list", "usage.cost", "workboard.cards.list"]) {
      await expectDenied(f.flexibleRead({ bindingId }));
    }
    await expectDenied(f.read({}, authorizationClient("anonymous", ["operator.sessions.read"])));
    await expectDenied(f.read({}, authorizationClient("unprivileged", [])));
    await expectDenied(
      f.dispatch("board.action", {
        ticket: await f.ticketFor(),
        action: "cron.trigger",
        jobId: "job",
      }),
    );
    const hidden = { ...target, sessionKey: "agent:main:hidden-ci" };
    await upsertSessionEntryCore(hidden, {
      ...f.entry,
      sessionId: "hidden-session",
      visibility: "draft",
    });
    await f.grantQuery("ci", query, hidden);
    await expectDenied(f.read({ ticket: await f.ticketFor(hidden, "ci", f.owner) }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + BOARD_VIEW_TICKET_TTL_MS + 1);
    await expectDenied(f.read());
    clock.mockRestore();
    const pending = await f.putQuery("pending");
    await expectDenied(f.read({ ticket: await f.signCurrentTicket("pending") }));
    await boardStore.grant(target, "pending", "rejected", pending.revision, pending.instanceId);
    await expectDenied(f.read({ ticket: await f.signCurrentTicket("pending") }));
    expect(f.actionCalls()).toHaveLength(1);
  }));

it("does not delegate manual flexible Actions queries through an existing repository-only grant", () =>
  withReader(async (f) => {
    const params = {
      repository: "owner/repo",
      workflow: "ci.yml",
      branch: "main",
      perPage: 1,
      excludePullRequests: true,
    };
    expect((await f.flexibleRead({ params }, f.owner)).mock.calls[0]).toEqual([true, result]);
    await expectDenied(f.flexibleRead({ params }));
    await expectDenied(
      f.flexibleRead({
        params: { repository: "owner/repo", branch: "unimplemented-filter", perPage: 1 },
      }),
    );
    await expectDenied(f.read());
    const added = await f.putQuery("ci");
    expect(added.grantState).toBe("pending");
    await expectDenied(f.read({ ticket: await f.signCurrentTicket("ci") }));
    await boardStore.grant(target, "ci", "granted", added.revision, added.instanceId);
    const ticket = await f.ticketFor();
    expect((await f.read({ ticket })).mock.calls[0]).toEqual([true, projected]);
    await expectDenied(f.flexibleRead({ ticket, params }));
    // The broader result was already cached; neither admission nor projection can borrow it.
    expect(f.actionCalls()).toHaveLength(1);
  }, true));

it("requires renewed approval for changed query definitions even with identical HTML", () =>
  withReader(async (f) => {
    expect((await f.read()).mock.calls[0]).toEqual([true, projected]);
    let oldTicket = await f.ticketFor();
    const changes: BoardWidgetDataQuery[] = [
      { ...query, params: { ...query.params, repository: "owner/other" } },
      { ...query, params: { ...query.params, workflow: "release.yml" } },
      { ...query, params: { ...query.params, branch: null } },
      { ...query, params: { ...query.params, status: "completed" } },
      { ...query, params: { ...query.params, created: ">=2026-10-01" } },
      { ...query, params: { ...query.params, perPage: 2 } },
      { ...query, params: { ...query.params, excludePullRequests: false } },
      { ...query, fields: ["conclusion"] },
      { ...query, name: "renamed" },
    ];
    for (const definition of changes) {
      const changed = await f.putQuery("ci", definition);
      expect(changed.grantState).toBe("pending");
      await expectDenied(f.read({ ticket: oldTicket }));
      await expectDenied(
        f.read({ ticket: await f.signCurrentTicket("ci"), queryName: definition.name }),
      );
      await f.grantQuery("ci");
      oldTicket = await f.ticketFor();
      expect((await f.read({ ticket: oldTicket })).mock.calls[0]).toEqual([true, projected]);
    }
    expect(f.actionCalls()).toHaveLength(1);
  }));

it("isolates same-name query parameters and projections while sharing only equivalent upstream reads", async ({
  signal,
}) =>
  withReader(async (f) => {
    await f.grantQuery("title", { ...query, fields: ["total_count", "display_title"] });
    await f.grantQuery("all", {
      ...query,
      params: { ...query.params, workflow: null, branch: null, perPage: 2 },
      fields: ["id", "head_branch"],
    });
    const titleTicket = await f.ticketFor(target, "title");
    const allTicket = await f.ticketFor(target, "all");
    const started = createDeferred();
    const release = createDeferred();
    let upstream = 0;
    f.setActions(async () => {
      upstream += 1;
      if (upstream === 2) {
        started.resolve();
      }
      await release.promise;
      return new Response(JSON.stringify(result));
    });
    const pending = Promise.all([
      f.read(),
      f.read({ ticket: titleTicket }),
      f.read({ ticket: allTicket }),
    ]);
    try {
      await withinTest(
        awaitGateBeforeSettlement(started.promise, pending, "Expected distinct upstream queries"),
        signal,
      );
    } finally {
      release.resolve();
    }
    const responses = await pending;
    expect(responses[0]!.mock.calls[0]).toEqual([true, projected]);
    expect(responses[1]!.mock.calls[0]).toEqual([
      true,
      { total_count: 1, workflow_runs: [{ display_title: "Private release summary" }] },
    ]);
    expect(responses[2]!.mock.calls[0]).toEqual([
      true,
      { workflow_runs: [{ id: 4242, head_branch: "main" }] },
    ]);
    expect(
      f
        .actionCalls()
        .map(([url]) => toRequestUrl(url))
        .toSorted(),
    ).toEqual(
      [
        queryUrl,
        "https://api.github.com/repos/owner/repo/actions/runs?per_page=2&exclude_pull_requests=true",
      ].toSorted(),
    );
    expect((await f.read()).mock.calls[0]).toEqual([true, projected]);
    expect((await f.read({ ticket: titleTicket })).mock.calls[0]).toEqual(
      responses[1]!.mock.calls[0],
    );
    expect((await f.read({ ticket: allTicket })).mock.calls[0]).toEqual(
      responses[2]!.mock.calls[0],
    );
    expect(f.actionCalls()).toHaveLength(2);
  }));

it.for(["visibility", "grant"] as const)(
  "revokes a reader before final delivery and warm-cache replay (%s)",
  async (change, { signal }) =>
    withReader(async (f) => {
      await f.grantQuery("cache-control");
      const controlTicket = await f.ticketFor(target, "cache-control");
      const started = createDeferred();
      const release = createDeferred();
      f.setActions(async () => {
        started.resolve();
        await release.promise;
        return new Response(JSON.stringify(result));
      });
      const pending = f.read();
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            started.promise,
            pending,
            "Expected an admitted upstream query",
          ),
          signal,
        );
        if (change === "visibility") {
          await upsertSessionEntryCore(target, { ...f.entry, visibility: "draft" });
        } else {
          const updated = await f.putQuery("ci", {
            ...query,
            params: { ...query.params, branch: "release" },
          });
          await boardStore.grant(target, "ci", "rejected", updated.revision, updated.instanceId);
        }
      } finally {
        release.resolve();
      }
      await expectDenied(pending);
      await expectDenied(f.read());
      // An independently authorized query proves that the populated cache is deliverable.
      expect((await f.read({ ticket: controlTicket }, f.owner)).mock.calls[0]).toEqual([
        true,
        projected,
      ]);
      await expectDenied(f.read());
      expect(f.actionCalls()).toHaveLength(1);
    }),
);
