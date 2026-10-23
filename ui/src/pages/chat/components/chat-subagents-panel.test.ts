/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import { childSessionListQuery } from "../../../lib/sessions/child-session-data.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSubagentsPanel } from "./chat-subagents-panel.tsx";

function mountPanel(handler: (method: string, params?: unknown) => unknown, mobile?: boolean) {
  const request = vi.fn(handler);
  const connection = createGatewayHarness(createTestGatewayClient(request));
  connection.publish({
    hello: gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "sessions.list",
      "sessions.subscribe",
      "sessions.unsubscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "chat.history",
    ]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createSolidApplicationContextProvider(
    createContext(connection.gateway, sessions),
  );
  const view = mountSolid(
    () => createComponent(ChatSubagentsPanel, { sessionKey: "agent:main:parent", mobile }),
    { wrapper: provider.wrapper },
  );
  const panel = view.container.querySelector<
    HTMLElementTagNameMap["openclaw-chat-subagents-panel"]
  >("openclaw-chat-subagents-panel")!;
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  return { panel, request, sessions, connection };
}

it("retains detail while hidden and applies a show request after its complete scope change", async () => {
  const key = (agentId: string) => `agent:${agentId}:subagent:child`;
  const child = (agentId: string, spawnedBy: string): GatewaySessionRow => ({
    key: key(agentId),
    agentId,
    sessionId: `${agentId}-child-session`,
    spawnedBy,
    kind: "direct",
    classification: "subagent",
    status: "done",
    sharingRole: "owner",
    updatedAt: 1,
  });
  const request = vi.fn((method: string, params?: unknown): unknown => {
    const values = asOptionalRecord(params);
    if (method === "sessions.list") {
      const rows =
        typeof values?.spawnedBy === "string"
          ? [child(values.agentId === "worker" ? "worker" : "main", values.spawnedBy)]
          : [];
      return { ...sessionsResult(rows, 1), hasMore: false, nextOffset: null };
    }
    if (method === "chat.history") {
      const agentId = values?.sessionKey === key("worker") ? "worker" : "main";
      return {
        sessionId: `${agentId}-child-session`,
        messages: [],
        hasMore: false,
        totalMessages: 0,
      };
    }
    if (method === "sessions.subscribe" || method === "sessions.unsubscribe") {
      return {};
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const { panel } = mountPanel(request);
  const pane = () => panel.querySelector("openclaw-chat-pane");
  const setPresented = async (presented: boolean) => {
    panel.presented = presented;
    await panel.updateComplete;
  };
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  panel.querySelector<HTMLButtonElement>(".chat-subagents__open")!.click();
  await panel.updateComplete;
  const retained = pane()!;
  expect(retained.sessionKey).toBe(key("main"));

  await setPresented(false);
  expect(pane()).toBe(retained);
  await setPresented(true);
  await waitForSolid(() => expect(pane()).toBe(retained));

  panel.showRequest = () => key("worker");
  panel.sessionKey = "global";
  panel.agentId = "worker";
  await panel.updateComplete;
  await waitForSolid(() => expect(pane()).toMatchObject({ sessionKey: key("worker") }));
  expect(pane()).toMatchObject({ agentId: "worker" });
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ spawnedBy: "global", agentId: "worker" }),
    ),
  );
  pane()!.onBackToSubagents?.();
  await panel.updateComplete;
  expect(pane()).toBeNull();
  await setPresented(false);
  await setPresented(true);
  await waitForSolid(() => expect(panel.querySelector(".chat-subagents__open")).not.toBeNull());
  expect(pane()).toBeNull();
});

const parentKey = "agent:main:parent";
const child = (id: string): GatewaySessionRow => ({
  key: `agent:worker:subagent:${id}`,
  agentId: "worker",
  sessionId: `session-${id}`,
  spawnedBy: parentKey,
  kind: "direct",
  classification: "subagent",
  status: "running",
  hasActiveRun: true,
  activeRunIds: [`run-${id}`],
  sharingRole: "owner",
  updatedAt: 1,
});
const page = (rows: GatewaySessionRow[], extra: Partial<SessionsListResult> = {}) => ({
  ...sessionsResult(rows),
  hasMore: false,
  nextOffset: null,
  ...extra,
});
const openSelector = (mobile?: boolean) =>
  mobile === true
    ? ".chat-subagents-mobile__open"
    : mobile === false
      ? ".subagents-desktop__open"
      : ".chat-subagents__open";

it.each([undefined, false, true])(
  "retains the %s list through an observed refresh and recovers a failed read",
  async (mobile) => {
    const first = child("first");
    const last = child("last");
    const initial = createDeferred<SessionsListResult>();
    const continuation = createDeferred<SessionsListResult>();
    const revalidation = createDeferred<SessionsListResult>();
    const metrics = createDeferred();
    let phase: "initial" | "refresh" | "ready" = "initial";
    const f = mountPanel((method, params) => {
      const values = asOptionalRecord(params);
      if (method === "sessions.list") {
        if (!values?.spawnedBy) {
          return page([]);
        }
        if (phase === "refresh") {
          return revalidation.promise;
        }
        if (phase === "ready") {
          return page([first, last]);
        }
        return values.offset ? continuation.promise : initial.promise;
      }
      if (method === "chat.history") {
        return metrics.promise;
      }
      return {};
    }, mobile);
    onTestFinished(() => {
      initial.resolve(page([first, last]));
      continuation.resolve(page([last]));
      revalidation.resolve(page([first, last]));
      metrics.resolve();
    });
    await waitForSolid(() => expect(f.panel.querySelector("[role=status]")).not.toBeNull());
    initial.resolve(page([first], { hasMore: true, nextOffset: 1, totalCount: 2 }));
    await waitForSolid(() =>
      expect(f.request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ offset: 1 }),
      ),
    );
    expect(f.panel.querySelector(openSelector(mobile))).toBeNull();
    continuation.resolve(page([last], { offset: 1, totalCount: 2 }));
    await waitForSolid(() =>
      expect(f.panel.querySelectorAll(openSelector(mobile))).toHaveLength(2),
    );
    const retained = f.panel.querySelector(openSelector(mobile));
    phase = "refresh";
    const refresh = f.sessions.refreshList({ ...childSessionListQuery(parentKey), force: true });
    await waitForSolid(() => expect(f.panel.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(f.panel.querySelector(openSelector(mobile))).toBe(retained);
    revalidation.reject(new Error("Child list read denied"));
    await refresh;
    await waitForSolid(() =>
      expect(f.panel.querySelector('[role="alert"]')?.textContent).toContain(
        "Child list read denied",
      ),
    );
    expect(f.panel.querySelector(openSelector(mobile))).toBeNull();
    phase = "ready";
    f.panel.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() =>
      expect(f.panel.querySelectorAll(openSelector(mobile))).toHaveLength(2),
    );
  },
);

it("keeps desktop row Stop feedback independent, preserves navigation, and releases it at acknowledgement", async () => {
  const rows = [child("first"), child("second")];
  const aborted = createDeferred<{ aborted: boolean }>();
  const revalidation = createDeferred<SessionsListResult>();
  let holdRefresh = false;
  const f = mountPanel((method, params) => {
    const values = asOptionalRecord(params);
    if (method === "sessions.list") {
      return values?.spawnedBy ? (holdRefresh ? revalidation.promise : page(rows)) : page([]);
    }
    if (method === "sessions.abort") {
      return aborted.promise;
    }
    if (method === "chat.history") {
      return {
        sessionId: values?.sessionKey === rows[0]!.key ? rows[0]!.sessionId : rows[1]!.sessionId,
        messages: [],
        hasMore: false,
        totalMessages: 0,
      };
    }
    return {};
  }, false);
  onTestFinished(() => {
    aborted.resolve({ aborted: true });
    revalidation.resolve(page(rows));
  });
  const stops = () => f.panel.querySelectorAll<HTMLButtonElement>(".subagents-desktop__stop");
  await waitForSolid(() => expect(stops()).toHaveLength(2));
  const retainedStop = stops()[0]!;
  const retainedOpen = f.panel.querySelector<HTMLButtonElement>(".subagents-desktop__open")!;
  retainedStop.click();
  await waitForSolid(() => expect(retainedStop.disabled).toBe(true));
  expect(stops()[1]!.disabled).toBe(false);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  retainedOpen.click();
  await waitForSolid(() =>
    expect(
      f.panel.querySelector("openclaw-chat-pane"),
      "opens detail while Stop is held",
    ).not.toBeNull(),
  );
  f.panel.querySelector("openclaw-chat-pane")!.onBackToSubagents?.();
  await waitForSolid(() => expect(f.panel.querySelector("openclaw-chat-pane")).toBeNull());
  expect(f.panel.querySelector(".subagents-desktop__open")).toBe(retainedOpen);
  holdRefresh = true;
  aborted.resolve({ aborted: true });
  await waitForSolid(() => expect(retainedStop.disabled).toBe(false));
  expect(f.panel.querySelector(".subagents-desktop__stop")).toBe(retainedStop);
  expect(
    f.panel.querySelector('[aria-busy="true"]'),
    "shows pending post-Stop refresh",
  ).not.toBeNull();
  revalidation.resolve(page(rows));
  await waitForSolid(() => expect(f.panel.querySelector('[aria-busy="true"]')).toBeNull());
});

it("does not redirect a mobile confirmation to a replacement run", async () => {
  let row = child("confirm");
  const f = mountPanel((method, params) => {
    const values = asOptionalRecord(params);
    if (method === "sessions.list") {
      return page(values?.spawnedBy ? [row] : []);
    }
    if (method === "chat.history") {
      return { sessionId: row.sessionId, messages: [], hasMore: false, totalMessages: 0 };
    }
    if (method === "sessions.abort") {
      return { aborted: true };
    }
    return {};
  }, true);
  await waitForSolid(() =>
    expect(f.panel.querySelector(".chat-subagents-mobile__stop")).not.toBeNull(),
  );
  f.panel.querySelector<HTMLButtonElement>(".chat-subagents-mobile__stop")!.click();
  const confirm = () => document.querySelector<HTMLButtonElement>("openclaw-modal-actions .danger");
  await waitForSolid(() => expect(confirm()).not.toBeNull());
  row = { ...row, activeRunIds: ["replacement-run"], updatedAt: 2 };
  await f.sessions.refreshList({ ...childSessionListQuery(parentKey), force: true });
  await waitForSolid(() =>
    expect(f.panel.querySelector(".chat-subagents-mobile__stop")).not.toBeNull(),
  );
  confirm()!.click();
  await waitForSolid(() => expect(confirm()).toBeNull());
  expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([]);
});

it.each(["parent", "hidden", "connection"] as const)(
  "retires held Stop feedback on %s replacement",
  async (replacement) => {
    const aborted = createDeferred<{ aborted: boolean }>();
    const f = mountPanel((method, params) => {
      const values = asOptionalRecord(params);
      if (method === "sessions.list") {
        const spawnedBy = typeof values?.spawnedBy === "string" ? values.spawnedBy : undefined;
        return page(spawnedBy ? [{ ...child(spawnedBy), spawnedBy }] : []);
      }
      if (method === "sessions.abort") {
        return aborted.promise;
      }
      if (method === "chat.history") {
        return {
          sessionId: `session-${parentKey}`,
          messages: [],
          hasMore: false,
          totalMessages: 0,
        };
      }
      return {};
    }, false);
    onTestFinished(() => aborted.resolve({ aborted: true }));
    const stop = () => f.panel.querySelector<HTMLButtonElement>(".subagents-desktop__stop");
    await waitForSolid(() => expect(stop()).not.toBeNull());
    stop()!.click();
    await waitForSolid(() => expect(stop()!.disabled).toBe(true));
    if (replacement === "parent") {
      f.panel.sessionKey = "agent:main:replacement";
    } else if (replacement === "hidden") {
      f.panel.presented = false;
      await f.panel.updateComplete;
      f.panel.presented = true;
    } else {
      f.connection.publish({ phase: "reconnecting" });
      f.connection.publish({ phase: "connected" });
    }
    await waitForSolid(() => expect(stop()?.disabled).toBe(false));
    aborted.resolve({ aborted: true });
    await waitForSolid(() => expect(f.panel.querySelector('[role="alert"]')).toBeNull());
    expect(stop()?.disabled).toBe(false);
  },
);
