import { afterEach, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
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
const result = { total_count: 0, workflow_runs: [] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function withReader(
  run: (fixture: Awaited<ReturnType<typeof prepareReader>>) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prepareProfileCatalog: true,
      env: { GH_TOKEN: "synthetic-actions-token", GITHUB_TOKEN: undefined },
    },
    async () => {
      const fixture = await prepareReader();
      try {
        await run(fixture);
      } finally {
        await fixture.work.drain();
      }
    },
  );
}

async function prepareReader() {
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
  const saved = await boardStore.putWidget({
    ...target,
    name: "ci",
    content: { kind: "html", html: "<p>CI</p>" },
    declared: { tools: ["github.actions.runs:owner/repo"] },
  });
  const widget = saved.widgets[0]!;
  await boardStore.grant(target, "ci", "granted", widget.revision, widget.instanceId);
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
  let actions = async () => new Response(JSON.stringify(result));
  const http = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      toRequestUrl(url).endsWith("/user")
        ? new Response(JSON.stringify({ id: 100, login: "fixture-user", avatar_url: null }))
        : actions(),
    );
  vi.stubGlobal("fetch", http);
  const read = (overrides: Record<string, unknown> = {}, client = viewer) =>
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
    widget,
    work,
    read,
    dispatch,
    ticketFor,
    http,
    setActions: (next: typeof actions) => {
      actions = next;
    },
    actionCalls: () =>
      http.mock.calls.filter(([url]) => toRequestUrl(url).includes("/actions/runs")),
  };
}

async function expectDenied(
  pending: ReturnType<Awaited<ReturnType<typeof prepareReader>>["read"]>,
) {
  const response = await pending;
  expect(response.mock.calls[0]).toMatchObject([false, undefined, { message: expect.any(String) }]);
  expect(JSON.stringify(response.mock.calls)).not.toContain("synthetic-actions-token");
}

it("serves approved Actions through real session-reader admission without widening host bindings", () =>
  withReader(
    async ({ read, viewer, owner, actionCalls, dispatch, ticketFor, signCurrentTicket, entry }) => {
      expect((await read()).mock.calls[0]).toEqual([true, result]);
      expect((await read()).mock.calls[0]).toEqual([true, result]);
      for (const scopes of [["operator.sessions.write"], ["operator.read"]]) {
        viewer.connect.scopes = scopes;
        expect((await read()).mock.calls[0]).toEqual([true, result]);
      }
      viewer.connect.scopes = ["operator.sessions.read"];
      expect(actionCalls()).toHaveLength(1);
      // The same cached transport is never authority for another repository or host operation.
      for (const overrides of [
        { params: { repository: "owner/other" } },
        { params: { repository: "owner/repo", url: "https://example.test" } },
        { bindingId: "sessions.list" },
        { bindingId: "usage.cost" },
        { bindingId: "workboard.cards.list" },
        { ticket: "forged" },
      ]) {
        await expectDenied(read(overrides));
      }
      await expectDenied(read({}, authorizationClient("anonymous", ["operator.sessions.read"])));
      await expectDenied(read({}, authorizationClient("unprivileged", [])));
      await expectDenied(
        dispatch("board.action", {
          ticket: await ticketFor(),
          action: "cron.trigger",
          jobId: "job",
        }),
      );

      await boardStore.putWidget({
        ...target,
        name: "unapproved",
        content: { kind: "html", html: "<p>No grant</p>" },
      });
      await expectDenied(read({ ticket: await ticketFor(target, "unapproved") }));
      const hidden = { ...target, sessionKey: "agent:main:hidden-ci" };
      await upsertSessionEntryCore(hidden, {
        ...entry,
        sessionId: "hidden-session",
        visibility: "draft",
      });
      const saved = await boardStore.putWidget({
        ...hidden,
        name: "ci",
        content: { kind: "html", html: "<p>Private CI</p>" },
        declared: { tools: ["github.actions.runs:owner/repo"] },
      });
      const hiddenWidget = saved.widgets[0]!;
      await boardStore.grant(
        hidden,
        "ci",
        "granted",
        hiddenWidget.revision,
        hiddenWidget.instanceId,
      );
      // A genuine ticket from another session does not confer that session's visibility.
      await expectDenied(read({ ticket: await ticketFor(hidden, "ci", owner) }));

      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + BOARD_VIEW_TICKET_TTL_MS + 1);
      await expectDenied(read());
      clock.mockRestore();
      const pending = await boardStore.putWidget({
        ...target,
        name: "pending",
        content: { kind: "html", html: "<p>Pending</p>" },
        declared: { tools: ["github.actions.runs:owner/repo"] },
      });
      // A correctly signed ticket still cannot approve a pending or rejected grant.
      await expectDenied(read({ ticket: await signCurrentTicket("pending") }));
      const pendingWidget = pending.widgets.find((item) => item.name === "pending")!;
      await boardStore.grant(
        target,
        "pending",
        "rejected",
        pendingWidget.revision,
        pendingWidget.instanceId,
      );
      await expectDenied(read({ ticket: await signCurrentTicket("pending") }));
      const currentTicket = await ticketFor();
      expect((await read({ ticket: currentTicket })).mock.calls[0]).toEqual([true, result]);
      await boardStore.putWidget({
        ...target,
        name: "ci",
        content: { kind: "html", html: "<p>Changed revision</p>" },
        declared: { tools: ["github.actions.runs:owner/repo"] },
      });
      await expectDenied(read({ ticket: currentTicket }));
      expect(actionCalls()).toHaveLength(1);
    },
  ));

it.each(["visibility", "grant"] as const)(
  "revokes a reader during an awaited Actions read (%s)",
  (change) =>
    withReader(async ({ read, entry, setActions, actionCalls }) => {
      const started = createDeferred();
      const release = createDeferred();
      setActions(async () => {
        started.resolve();
        await release.promise;
        return new Response(JSON.stringify(result));
      });
      const pending = read();
      try {
        await started.promise;
        if (change === "visibility") {
          await upsertSessionEntryCore(target, { ...entry, visibility: "draft" });
        } else {
          // Replacing approved bytes retires their grant; the new decision can be rejected.
          const updated = await boardStore.putWidget({
            ...target,
            name: "ci",
            content: { kind: "html", html: "<p>Revoked</p>" },
            declared: { tools: ["github.actions.runs:owner/repo"] },
          });
          const current = updated.widgets[0]!;
          await boardStore.grant(target, "ci", "rejected", current.revision, current.instanceId);
        }
      } finally {
        release.resolve();
      }
      await expectDenied(pending);
      // The successfully populated shared cache must not restore the revoked caller's access.
      await expectDenied(read());
      expect(actionCalls()).toHaveLength(1);
    }),
);
