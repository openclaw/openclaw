/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../extensions/github-repositories/session-pull-requests-api.ts";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGatewayHarness as createReadGateway,
  flushSync,
} from "../plugins/github-repositories-integration/session-pull-requests.test-support.ts";
import {
  catalogPage,
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { installRepositoryPresentation } from "../test-helpers/repository-presentation.test-support.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

const key = "agent:main:repository-row";
const hint = { numbers: [40], state: "open" as const };
const pullRequest = (number: number, state: "open" | "draft" | "merged" | "closed" = "open") => ({
  number,
  state,
  owner: "openclaw",
  repo: "openclaw",
  branch: "feature/demo",
  title: `PR ${number}`,
  url: `https://github.com/openclaw/openclaw/pull/${number}`,
});
async function mountRow(
  fields: Partial<GatewaySessionRow> = {},
  scopes = ["operator.read"],
  catalog?: "foreign" | "adopted",
  empty = false,
) {
  const request = vi.fn(async (_method: string, _params?: unknown) => ({ subscribed: true }));
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    hello: gatewayHelloForMethods([SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD], scopes),
  });
  const sessions = createSessionsHarness("main", []);
  const row: GatewaySessionRow = {
    key,
    sessionId: "repository-row",
    kind: "direct",
    updatedAt: 1,
    label: "Repository row",
    ...fields,
  };
  sessions.publishList({
    result: {
      ...sessions.sessions.state.result!,
      sessions: catalog === "foreign" || empty ? [] : [row],
      count: catalog === "foreign" || empty ? 0 : 1,
    },
  });
  const activation = installRepositoryPresentation(
    createContext(gateway.gateway, sessions.sessions),
  );
  await activation.ready;
  const mounted = await mountSidebarContext(activation.context);
  mounted.sidebar.connected = true;
  const rowKey =
    catalog === "foreign"
      ? buildCatalogSessionKey(
          { catalogId: "codex", hostId: "gateway:local", threadId: "catalog-row" },
          "main",
        )
      : key;
  if (catalog) {
    const page = catalogPage([
      {
        threadId: "catalog-row",
        name: "Catalog repository row",
        ...(catalog === "adopted" ? { sessionKey: key } : {}),
      },
    ]);
    page.catalogs[0]!.hosts[0]!.sessions[0]!.pullRequest = hint;
    mounted.sidebar.sessionData.sessionCatalogs = page.catalogs;
    mounted.sidebar.invalidate();
  }
  if (!empty) {
    await waitForSolid(() =>
      expect(mounted.sidebar.querySelector(`[data-session-key="${rowKey}"]`)).not.toBeNull(),
    );
  }
  const badge = () =>
    mounted.sidebar.querySelector(
      `[data-session-key="${rowKey}"] .session-row-badge--pull-request`,
    );
  const push = (snapshot: Record<string, unknown>) =>
    gateway.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: { [key]: { pullRequests: [], status: "ready", rateLimited: false, ...snapshot } },
    });
  const action = activation.context.plugins
    .registrations("actions")
    .find((entry) => entry.value.id === "open-pull-request")!.value;
  const subscriptions = () =>
    request.mock.calls.filter(([method]) => method === SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
  return {
    ...mounted,
    gateway,
    sessions,
    request,
    badge,
    push,
    activation,
    subscriptions,
    row,
    action,
  };
}

describe("GitHub plugin session-row accessory", () => {
  it("does not subscribe to PR status for session-only sidebar viewers", async () => {
    const h = await mountRow(
      { worktree: { id: "worktree", branch: "feature", repoRoot: "/synthetic" } },
      ["operator.sessions.read", "operator.sessions.write"],
    );
    expect(h.subscriptions()).toHaveLength(0);
    expect(h.badge()).toBeNull();
  });
  it("shows and clears the badge from the session-only reader's own conversation read", async () => {
    const h = await mountRow(
      { worktree: { id: "worktree", branch: "feature", repoRoot: "/synthetic" } },
      ["operator.sessions.read", "operator.sessions.write"],
    );
    expect(h.subscriptions()).toHaveLength(0);
    const signal = new AbortController();
    const stop = h.action.observe!(
      { sessionKey: key, session: h.row, signal: signal.signal },
      () => {},
    );
    onTestFinished(stop);
    await waitForSolid(() => expect(h.subscriptions().at(-1)?.[1]).toEqual({ sessionKeys: [key] }));
    h.push({ pullRequests: [pullRequest(42)] });
    await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("#42"));
    stop();
    await waitForSolid(() => expect(h.badge()).toBeNull());
  });
  it("keeps empty rows idle across sidebar updates", async () => {
    const h = await mountRow({}, ["operator.read"], undefined, true);
    const before = h.subscriptions().length;
    expect(before).toBe(0);
    h.sidebar.invalidate();
    h.sidebar.invalidate();
    await h.sidebar.updateComplete;
    expect(h.subscriptions()).toHaveLength(before);
    expect(h.badge()).toBeNull();
  });
  it.each(["merged"] as const)(
    "observes visible rows and keeps the pushed %s summary through backoff",
    async (state) => {
      const h = await mountRow();
      h.push({ pullRequests: [pullRequest(42, state)] });
      await waitForSolid(() =>
        expect(h.badge()?.getAttribute("data-pull-request-state")).toBe(state),
      );
      h.push({ pullRequests: [], status: "rate-limited", rateLimited: true, branchRead: false });
      await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("#42"));
      expect(h.subscriptions().at(-1)?.[1]).toEqual({ sessionKeys: [], passiveSessionKeys: [key] });
    },
  );
  it("counts cold task receipts without a worktree or an invented state", async () => {
    const h = await mountRow();
    h.push({
      branchRead: false,
      taskPullRequestCount: 3,
      taskPullRequests: [{ ...pullRequest(42), sourceSessionKey: "agent:main:task" }],
    });
    await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("3"));
    expect(h.badge()?.getAttribute("data-pull-request-state")).toBeNull();
  });
  it("preserves catalog branch facts only while receipt-only hydration leaves the branch unread", async () => {
    const h = await mountRow({}, ["operator.read"], "adopted");
    await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("#40"));
    h.push({ branchRead: false });
    await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("#40"));
    h.push({ branchRead: true, pullRequestCount: 0 });
    await waitForSolid(() => expect(h.badge()).toBeNull());
  });
  it("clears alias indicators when the selected agent changes", async () => {
    const h = await mountRow();
    h.push({ pullRequests: [pullRequest(42)] });
    await waitForSolid(() => expect(h.badge()).not.toBeNull());
    h.activation.context.agentSelection.set("research");
    h.sessions.publishList({
      agentId: "research",
      result: { ...h.sessions.sessions.state.result!, count: 0, sessions: [] },
    });
    await waitForSolid(() => expect(h.badge()).toBeNull());
    expect(h.subscriptions().at(-1)?.[1]).toEqual({ sessionKeys: [] });
  });
  it("clears a structural session's indicator while replacement data is pending", async () => {
    const h = await mountRow();
    h.push({ pullRequests: [pullRequest(42)] });
    await waitForSolid(() => expect(h.badge()).not.toBeNull());
    h.gateway.publishEvent("sessions.changed", {
      sessionKey: key,
      agentId: "main",
      reason: "branch-switch",
    });
    await waitForSolid(() => expect(h.badge()).toBeNull());
  });
  it.each(["agent", "client", "permissions", "sessions"] as const)(
    "retires %s scope while summaries are parked",
    async (mode) => {
      const h = await mountRow();
      h.push({ pullRequests: [pullRequest(42)] });
      await waitForSolid(() => expect(h.badge()).not.toBeNull());
      if (mode === "permissions") {
        h.gateway.publish({
          hello: gatewayHelloForMethods(
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
            ["operator.sessions.read"],
          ),
        });
      } else if (mode === "client") {
        h.gateway.publish({
          client: createTestGatewayClient(vi.fn(async () => ({ subscribed: true }))),
        });
      } else if (mode === "agent") {
        h.gateway.publish({ assistantAgentId: "replacement", phase: "reconnecting" });
      } else {
        h.activation.dispose();
      }
      await waitForSolid(() => expect(h.badge()).toBeNull());
    },
  );
  it("hides the row's saved PR summary after a same-client read-scope revocation", async () => {
    const h = await mountRow(
      { worktree: { id: "scoped", branch: "feature", repoRoot: "/synthetic" } },
      ["operator.read"],
      "adopted",
    );
    await waitForSolid(() => expect(h.badge()).not.toBeNull());
    h.gateway.publish({
      hello: gatewayHelloForMethods(
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        ["operator.sessions.read"],
      ),
    });
    await waitForSolid(() => expect(h.badge()).toBeNull());
  });
  it("retains sidebar snapshots while only the viewed checkout drives subscriptions", async () => {
    const h = await mountRow();
    h.push({ pullRequests: [pullRequest(42)] });
    await waitForSolid(() => expect(h.badge()).not.toBeNull());
    expect(h.subscriptions().at(-1)?.[1]).toEqual({ sessionKeys: [], passiveSessionKeys: [key] });
    h.sidebar.invalidate();
    await h.sidebar.updateComplete;
    expect(h.badge()?.getAttribute("aria-label")).toContain("#42");
  });
  it("clears a rendered fallback after the visible snapshot leaves the bounded watch union", async () => {
    const h = await mountRow();
    h.push({ pullRequests: [pullRequest(42)] });
    await waitForSolid(() => expect(h.badge()).not.toBeNull());
    const controller = new AbortController();
    const stops = Array.from({ length: CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS }, (_, i) =>
      h.action.observe!({ sessionKey: `agent:main:a${i}`, signal: controller.signal }, () => {}),
    );
    onTestFinished(() => {
      controller.abort();
      stops.forEach((stop) => stop());
    });
    await waitForSolid(() => expect(h.badge()).toBeNull());
  });
  it("keeps sidebar watches passive across disconnect and reconnect", async () => {
    const h = createReadGateway();
    const owner = {};
    h.repository.store.watch(owner, [key], { passive: true });
    await flushSync();
    expect(h.request.mock.calls.at(-1)?.[1]).toEqual({
      sessionKeys: [],
      passiveSessionKeys: [key],
    });
    h.setSnapshot({ ...h.gateway.snapshot, phase: "reconnecting" });
    h.setSnapshot({ ...h.gateway.snapshot, phase: "connected" });
    await flushSync();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.at(-1)?.[1]).toEqual({
      sessionKeys: [],
      passiveSessionKeys: [key],
    });
  });
});

it("retains the plugin badge artwork when a receipt confirms its displayed count", async () => {
  const h = await mountRow({
    worktree: { id: "worktree", branch: "feature", repoRoot: "/synthetic" },
  });
  h.push({ pullRequests: [pullRequest(17)] });
  await waitForSolid(() => expect(h.badge()?.getAttribute("aria-label")).toContain("#17"));
  const original = h.badge();
  h.push({ pullRequests: [pullRequest(17)], pullRequestCount: 1 });
  await waitForSolid(() => expect(h.badge()).toBe(original));
  h.push({ pullRequests: [pullRequest(17)], pullRequestCount: 2 });
  await waitForSolid(() =>
    expect(h.badge()?.getAttribute("aria-label")).toContain("2 pull requests"),
  );
});
