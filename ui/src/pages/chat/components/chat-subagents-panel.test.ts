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

const history = (sessionId: GatewaySessionRow["sessionId"]) => ({
  sessionId,
  messages: [],
  hasMore: false,
  totalMessages: 0,
});

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
  const panel = view.container.querySelector("openclaw-chat-subagents-panel")!;
  const find = (selector: string) => panel.querySelector<HTMLButtonElement>(selector);
  const waitForCount = (selector: string, count: number) =>
    waitForSolid(() => expect(panel.querySelectorAll(selector)).toHaveLength(count));
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  return { panel, request, sessions, connection, find, waitForCount };
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
      return history(`${agentId}-child-session`);
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
function mountRows(
  rows: (params?: Record<string, unknown>) => GatewaySessionRow[],
  mobile?: boolean,
  handlers: {
    list?: () => unknown;
    abort?: () => unknown;
    history?: () => unknown;
  } = {},
) {
  return mountPanel((method, params) => {
    const values = asOptionalRecord(params);
    if (method === "sessions.list") {
      return values?.spawnedBy ? (handlers.list?.() ?? page(rows(values))) : page([]);
    }
    if (method === "chat.history") {
      if (handlers.history) {
        return handlers.history();
      }
      const entries = rows(values);
      return history(
        (entries.find((row) => row.key === values?.sessionKey) ?? entries.at(-1))?.sessionId,
      );
    }
    return method === "sessions.abort" ? (handlers.abort?.() ?? {}) : {};
  }, mobile);
}
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
        return initial.promise;
      }
      if (method === "chat.history") {
        return metrics.promise;
      }
      return {};
    }, mobile);
    onTestFinished(() => {
      initial.resolve(page([first, last]));
      revalidation.resolve(page([first, last]));
      metrics.resolve();
    });
    await waitForSolid(() => expect(f.panel.querySelector("[role=status]")).not.toBeNull());
    expect(f.panel.querySelector(openSelector(mobile))).toBeNull();
    initial.resolve(page([first, last]));
    await f.waitForCount(openSelector(mobile), 2);
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
    await f.waitForCount(openSelector(mobile), 2);
  },
);

it.each([undefined, true])(
  "retries a rejected Stop from the %s notice and restores mobile feedback focus",
  async (mobile) => {
    const row = child("retry");
    const f = mountRows(() => [row], mobile, {
      abort: () => {
        throw new Error("Stop denied by fixture");
      },
    });
    const stopSelector = mobile ? ".chat-subagents-mobile__stop" : ".chat-subagents__stop";
    await f.waitForCount(stopSelector, 1);
    f.find(stopSelector)!.click();
    if (mobile) {
      const confirm = () =>
        document.querySelector<HTMLButtonElement>("openclaw-modal-actions .danger");
      await waitForSolid(() => expect(confirm()).not.toBeNull());
      confirm()!.click();
    }
    const retry = () => f.find('[role="alert"] button');
    await waitForSolid(() =>
      expect(f.panel.querySelector('[role="alert"]')?.textContent).toContain(
        "Stop denied by fixture",
      ),
    );
    if (mobile) {
      // Touch navigation need not focus its row button.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      f.find(openSelector(mobile))!.click();
      await waitForSolid(() => expect(f.panel.querySelector("openclaw-chat-pane")).not.toBeNull());
      f.panel.querySelector("openclaw-chat-pane")!.onBackToSubagents?.();
      await waitForSolid(() => expect(document.activeElement).toBe(retry()));
    }
    retry()!.click();
    await waitForSolid(() => expect(f.panel.querySelector('[role="alert"]')).toBeNull());
    expect(f.panel.querySelector(openSelector(mobile))).not.toBeNull();
  },
);

it("keeps desktop row Stop feedback independent, preserves navigation, and releases it at acknowledgement", async () => {
  const rows = [child("first"), child("second")];
  const aborted = createDeferred<{ aborted: boolean }>();
  const revalidation = createDeferred<SessionsListResult>();
  let holdRefresh = false;
  const f = mountRows(() => rows, false, {
    list: () => (holdRefresh ? revalidation.promise : page(rows)),
    abort: () => aborted.promise,
  });
  onTestFinished(() => {
    aborted.resolve({ aborted: true });
    revalidation.resolve(page(rows));
  });
  const stops = () => f.panel.querySelectorAll<HTMLButtonElement>(".subagents-desktop__stop");
  await waitForSolid(() => expect(stops()).toHaveLength(2));
  const retainedStop = stops()[0]!;
  const retainedOpen = f.find(".subagents-desktop__open")!;
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
  const f = mountRows(() => [row], true, { abort: () => ({ aborted: true }) });
  await f.waitForCount(".chat-subagents-mobile__stop", 1);
  f.find(".chat-subagents-mobile__stop")!.click();
  const confirm = () => document.querySelector<HTMLButtonElement>("openclaw-modal-actions .danger");
  await waitForSolid(() => expect(confirm()).not.toBeNull());
  row = { ...row, activeRunIds: ["replacement-run"], updatedAt: 2 };
  await f.sessions.refreshList({ ...childSessionListQuery(parentKey), force: true });
  await f.waitForCount(".chat-subagents-mobile__stop", 1);
  confirm()!.click();
  await waitForSolid(() => expect(confirm()).toBeNull());
  expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([]);
});

it.each(["parent", "hidden", "connection"] as const)(
  "retires held Stop feedback on %s replacement",
  async (replacement) => {
    const aborted = createDeferred<{ aborted: boolean }>();
    const f = mountRows(
      (params) => {
        const spawnedBy = typeof params?.spawnedBy === "string" ? params.spawnedBy : parentKey;
        return [{ ...child(spawnedBy), spawnedBy }];
      },
      false,
      { abort: () => aborted.promise, history: () => history(`session-${parentKey}`) },
    );
    onTestFinished(() => aborted.resolve({ aborted: true }));
    const stop = () => f.find(".subagents-desktop__stop");
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
