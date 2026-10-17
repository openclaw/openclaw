/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../app/overlays.ts";
import {
  createSidebarAttentionStore,
  type SidebarAttentionStore,
} from "../app/sidebar-attention-store.ts";
import { invalidateModelAuthStatusRequests } from "../lib/model-auth-request-state.ts";
import {
  createApplicationContextProvider,
  hiddenScopeUpgradeCapability,
} from "../test-helpers/application-context.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { buildSidebarAttentionEntries } from "./sidebar-attention-items.ts";
import { cronPage } from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";
import "./sidebar-attention.tsx";

const ATTENTION_KEY = 'openclaw.control.sidebarAttention.v2:["ws://gateway.test","alice"]';

function cronResponse(id?: string, nextRunAtMs?: number) {
  const page = cronPage(id);
  const job = page.jobs[0];
  if (job && nextRunAtMs !== undefined) {
    Object.assign(job, {
      lastRunStatus: "ok",
      nextRunAtMs,
      nextRunAt: new Date(nextRunAtMs).toISOString(),
    });
  }
  return { ...page, snapshotRevision: "sidebar-attention-cron-fixture" };
}

const mentionItem = (id: string) => ({ ...inboxMention(id), sessionKey: "agent:writer:review" });

type SidebarAttentionElement = HTMLElement & {
  context: ApplicationContext;
  dismissPanel: () => boolean;
  onNavigate?: ApplicationContext["navigate"];
};

function authStatus(ts: number, status: "missing" | "ok" = "missing"): ModelAuthStatusResult {
  return { ts, providers: [{ provider: "openai", displayName: "OpenAI", status, profiles: [] }] };
}

function authItems(agentId: string, modelAuthStatus = authStatus(1)) {
  return buildSidebarAttentionEntries({
    cronJobs: [],
    cronSchedulerEnabled: true,
    modelAuthStatus,
    modelAuthAgentId: agentId,
    now: 0,
  }).filter((item) => item.kind === "modelAuthExpired");
}

function selection(selectedId: string, scopeId: string | null = selectedId) {
  return {
    state: { selectedId, scopeId },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agentSelection"];
}

function respond(responses: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    if (!Object.hasOwn(responses, method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    const response = responses[method];
    return typeof response === "function" ? response() : response;
  });
}

function queuedResponses(responses: Record<string, unknown[]>) {
  return vi.fn((method: string) => {
    const response = responses[method]?.shift();
    if (!response) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return Promise.resolve(response);
  });
}

function eventGateway(
  snapshot: object,
  connection: Partial<ApplicationGateway["connection"]> = { gatewayUrl: "ws://gateway.test" },
) {
  let listener: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
  return {
    gateway: {
      snapshot,
      connection,
      subscribe: () => () => undefined,
      subscribeEvents: (next: NonNullable<typeof listener>) => {
        listener = next;
        return () => undefined;
      },
    } as unknown as ApplicationGateway,
    emit: (event: string) => listener?.({ type: "event", event, payload: {} }),
  };
}

function cronStatus(jobs: number, enabled = true) {
  return { enabled, triggersEnabled: true, jobs };
}

function issues(element: ParentNode, suffix: string) {
  return element.querySelector<HTMLElement>(`.sidebar-issues-${suffix}`);
}

function attention(element: ParentNode, kind: string) {
  return element.querySelector(`[data-attention-kind="${kind}"]`);
}

function authText(element: ParentNode) {
  return attention(element, "modelAuthExpired")?.textContent?.replace(/\s+/g, " ");
}

async function openPanel(element: ParentNode, trigger: HTMLButtonElement) {
  trigger.click();
  await waitForFast(() => expect(issues(element, "panel")).not.toBeNull());
}

describe("model auth attention", () => {
  it("keeps identical provider warnings distinct across agents", () => {
    expect(authItems("main")[0]?.signature).toBe("agent:main\nopenai");
    expect(authItems("writer")[0]?.signature).toBe("agent:writer\nopenai");
  });

  it("keeps a missing canonical route visible beside CLI OAuth", () => {
    const items = authItems("main", {
      ts: 1,
      providers: [
        { provider: "anthropic", displayName: "Claude", status: "missing", profiles: [] },
        {
          provider: "claude-cli",
          displayName: "Claude",
          status: "expiring",
          profiles: [{ profileId: "anthropic:claude-cli", type: "oauth", status: "expiring" }],
        },
      ],
    });

    expect(items.some((entry) => entry.kind === "modelAuthExpired")).toBe(true);
  });

  it("presents expired providers to the custodian with raw status", () => {
    const item = authItems("main")[0];
    expect(item).toMatchObject({
      label: "OpenAI",
      inlineAction: { label: "Reconnect", routeId: "model-providers" },
    });
    const action = item?.action;
    expect(action).toMatchObject({ kind: "askCustodian" });
    if (action?.kind !== "askCustodian") {
      throw new Error("expected model auth custodian action");
    }
    expect(action.alert.facts).toEqual(["OpenAI: missing"]);
    expect(action.alert.question).toContain("OpenAI: missing");
    expect(action.alert.action?.target).toEqual({
      kind: "navigate",
      routeId: "model-providers",
    });
  });
});

describe("sidebar attention refresh ownership", () => {
  const stores = new Set<SidebarAttentionStore>();
  afterEach(() => {
    for (const store of stores) {
      store.dispose();
    }
    stores.clear();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mountAttention(
    overrides: Partial<Pick<ApplicationContext, "agentSelection" | "gateway" | "overlays">> = {},
  ) {
    const sources = {
      gateway: {
        snapshot: { phase: "connected", client: null, hello: null },
        connection: { gatewayUrl: "" },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      overlays: { snapshot: { approvalQueue: [] }, subscribe: () => () => undefined },
      agentSelection: {
        state: { selectedId: null, scopeId: null },
        subscribe: () => () => undefined,
      },
      scopeUpgrade: hiddenScopeUpgradeCapability,
      ...overrides,
      agents: { state: { agentsList: null }, subscribe: () => () => undefined },
    } as unknown as Parameters<typeof createSidebarAttentionStore>[0];
    const store = createSidebarAttentionStore(sources);
    store.activate(SidebarAttentionStoreController);
    stores.add(store);
    const provider = createApplicationContextProvider({
      ...sources,
      sidebarAttention: store,
    } as unknown as ApplicationContext);
    const element = document.createElement("openclaw-sidebar-attention") as SidebarAttentionElement;
    provider.append(element);
    document.body.append(provider);

    await waitForFast(() => expect(issues(element, "button")).not.toBeNull());
    const trigger = element.querySelector<HTMLButtonElement>(".sidebar-issues-button")!;
    return { element, provider, store, trigger };
  }

  it("keeps the plain attention panel inside its top-layer menu surface", async () => {
    const { element, trigger } = await mountAttention();
    trigger.click();
    await vi.dynamicImportSettled();
    flush();

    const panel = issues(element, "panel");
    expect(panel).not.toBeNull();
    expect(panel?.closest("openclaw-menu-surface")).not.toBeNull();
    panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(issues(element, "panel")).toBeNull();
    await waitForFast(() => expect(document.activeElement).toBe(trigger));
  });

  it.each([false, true])(
    "only dismisses on window blur into an outside frame: %s",
    async (outsideFrame) => {
      const { element, trigger } = await mountAttention();
      const frame = outsideFrame
        ? document.body.appendChild(document.createElement("iframe"))
        : null;
      await openPanel(element, trigger);

      // jsdom can focus the frame but does not emit the browsing-context blur.
      frame?.focus();
      window.dispatchEvent(new Event("blur"));
      flush();

      if (frame) {
        expect(issues(element, "panel")).toBeNull();
        expect(document.activeElement).toBe(frame);
      } else {
        expect(issues(element, "panel")).not.toBeNull();
      }
    },
  );

  it("updates cross-agent mentions and opens them through shell navigation", async () => {
    let result = { gatewayInstanceId: "boot-a", revision: 1, items: [mentionItem("first")] };
    const request = respond({
      "cron.list": cronResponse(),
      "cron.status": cronStatus(0),
      "models.authStatus": { ts: 1, providers: [] },
      "mentions.list": () => result,
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({
      hello: {
        type: "hello-ok",
        protocol: 1,
        server: { bootId: "boot-a", connId: "connection-a" },
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["mentions.list", "mentions.dismiss"] },
      },
      selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
    });
    const { element } = await mountAttention({
      gateway: harness.gateway,
      agentSelection: selection("main", "main"),
    });

    await waitForFast(() =>
      expect(issues(element, "button__count")?.textContent?.trim()).toBe("1"),
    );
    result = { ...result, revision: 2, items: [mentionItem("first"), mentionItem("second")] };
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
    await waitForFast(() =>
      expect(issues(element, "button__count")?.textContent?.trim()).toBe("2"),
    );
    expect(issues(element, "panel")).toBeNull();
    const onNavigate = vi.fn();
    element.onNavigate = onNavigate;
    issues(element, "button")!.click();
    await waitForFast(() => expect(element.querySelector(".sidebar-mention-row a")).not.toBeNull());
    element.querySelector<HTMLAnchorElement>(".sidebar-mention-row a")!.click();
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/writer/review" }),
    );
    flush();
    expect(issues(element, "panel")).toBeNull();
  });

  it("retains an open panel during a move but resets it after a genuine disconnect", async () => {
    const { element, provider, trigger } = await mountAttention();
    await openPanel(element, trigger);
    const panel = issues(element, "panel");

    element.remove();
    provider.append(element);
    flush();
    expect(issues(element, "panel")).toBe(panel);

    element.remove();
    await Promise.resolve();
    provider.append(element);
    await waitForFast(() => expect(issues(element, "button")).not.toBeNull());
    expect(issues(element, "panel")).toBeNull();
    const reconnectedTrigger = element.querySelector<HTMLButtonElement>(".sidebar-issues-button")!;
    expect(reconnectedTrigger.getAttribute("aria-expanded")).toBe("false");
    await openPanel(element, reconnectedTrigger);
  });

  it("keeps loaded health attention across a view-only remount", async () => {
    const request = respond({
      "cron.list": cronResponse("failed"),
      "cron.status": cronStatus(1),
      "models.authStatus": authStatus(1),
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    const { element, provider } = await mountAttention({
      gateway: harness.gateway,
      agentSelection: selection("main", null),
    });
    await waitForFast(() => expect(issues(element, "button__count")?.textContent).toBe("2"));

    element.remove();
    provider.append(element);

    expect(issues(element, "button__count")?.textContent).toBe("2");
  });

  it("keeps overdue jobs out of the Inbox while the scheduler is disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(300_002);
    const request = respond({
      "cron.list": cronResponse("overdue-id", 1),
      "cron.status": cronStatus(1, false),
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });

    const { element } = await mountAttention({ gateway: harness.gateway });

    await waitForFast(() => expect(request).toHaveBeenCalledWith("cron.status", {}));
    expect(issues(element, "button__count")).toBeNull();
  });

  it.each(["visible", "hidden"] as const)(
    "publishes a quiet automation's overdue warning after a %s deadline without polling",
    async (presentation) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 8, 22));
      let visibility: DocumentVisibilityState = "visible";
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
      vi.stubGlobal("localStorage", createTestStorageMock());
      const deadline = Date.now() + 300_000;
      const request = respond({
        "cron.list": cronResponse("quiet-deadline", Date.now()),
        "cron.status": cronStatus(1),
      });
      const harness = createGatewayHarness(mockClient(request));
      const { element } = await mountAttention({ gateway: harness.gateway });
      expect(request).toHaveBeenCalledTimes(2);
      if (presentation === "hidden") {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      flush();
      expect(issues(element, "button__count")).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      flush();
      if (presentation === "hidden") {
        expect(issues(element, "button__count")).toBeNull();
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        flush();
      }
      expect(issues(element, "button__count")?.textContent).toBe("1");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["open", "close"] as const)(
    "does not let obsolete %s focus steal a later interaction",
    async (operation) => {
      const { element, trigger } = await mountAttention();
      if (operation === "close") {
        await openPanel(element, trigger);
      }
      const pending: VoidFunction[] = [];
      vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) =>
        pending.push(callback),
      );
      if (operation === "open") {
        trigger.click();
        await vi.dynamicImportSettled();
      } else {
        issues(element, "panel")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      }
      flush();
      if (operation === "open") {
        expect(issues(element, "panel")).not.toBeNull();
      }
      const obsolete = pending.splice(0);
      if (operation === "open") {
        element.dismissPanel();
        flush();
      }
      trigger.click();
      await vi.dynamicImportSettled();
      flush();
      for (const callback of pending.splice(0)) {
        callback();
      }
      expect(document.activeElement).toBe(issues(element, "panel__list"));
      if (operation === "close") {
        element.dismissPanel();
        flush();
      }
      const nextControl = document.body.appendChild(document.createElement("button"));
      nextControl.focus();
      for (const callback of obsolete) {
        callback();
      }
      expect(document.activeElement).toBe(nextControl);
    },
  );

  it.each([
    { name: "same panel", reopen: false },
    { name: "reopened panel", reopen: true },
  ])("restores approval focus only within the initiating panel ($name)", async ({ reopen }) => {
    const resolution = deferred<unknown>();
    const request = respond({
      "exec.approval.resolve": () => resolution.promise,
      "update.status": { sentinel: null, updateAvailable: null },
      "cron.list": cronResponse(),
      "cron.status": cronStatus(0),
      "exec.approval.list": [],
      "plugin.approval.list": [],
      "openclaw.approval.list": [],
    });
    const harness = createGatewayHarness(mockClient(request));
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
    const overlays = createApplicationOverlays(harness.gateway);
    const decideApproval = vi.spyOn(overlays, "decideApproval");
    try {
      const { element, trigger } = await mountAttention({ gateway: harness.gateway, overlays });
      harness.emitApproval("remaining", 1);
      harness.emitApproval("selected", 2);
      trigger.click();
      const decisionSelector =
        '[data-approval-id="selected"] .sidebar-approval-row__action--allow-once';
      await waitForFast(() => expect(element.querySelector(decisionSelector)).not.toBeNull());
      element.querySelector<HTMLButtonElement>(decisionSelector)!.click();
      expect(decideApproval).toHaveBeenCalledExactlyOnceWith("allow-once", "selected");
      expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "selected",
        decision: "allow-once",
      });
      if (reopen) {
        element.dismissPanel();
        flush();
        trigger.click();
        await waitForFast(() =>
          expect(document.activeElement).toBe(issues(element, "panel__list")),
        );
      }
      const tab = element.querySelector<HTMLElement>("#sidebar-issues-tab-all")!;
      if (reopen) {
        tab.focus();
      }
      resolution.resolve({ ok: true });
      await decideApproval.mock.results[0]!.value;
      flush();

      expect(overlays.snapshot.approvalQueue.map((approval) => approval.id)).toEqual(["remaining"]);
      await waitForFast(() =>
        expect(document.activeElement).toBe(
          reopen
            ? tab
            : element.querySelector('[data-approval-id="remaining"] [data-issue-row-focus]'),
        ),
      );
    } finally {
      resolution.resolve({ ok: true });
      overlays.dispose();
    }
  });

  it.each(["success", "failure"] as const)(
    "keeps writer auth ownership after a stale Main %s settles",
    async (outcome) => {
      const pendingCron = deferred<unknown>();
      const staleAuth = deferred<ModelAuthStatusResult>();
      const switchedAuth = deferred<ModelAuthStatusResult>();
      const request = queuedResponses({
        "cron.list": [
          Promise.resolve(cronResponse("current")),
          pendingCron.promise,
          Promise.resolve(cronResponse("current")),
        ],
        "cron.status": Array.from({ length: 3 }, () => Promise.resolve(cronStatus(1))),
        "models.authStatus": [
          Promise.resolve(authStatus(1)),
          staleAuth.promise,
          switchedAuth.promise,
        ],
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, emit } = eventGateway({
        client,
        phase: "connected",
        selfUser: { id: "alice", name: "Alice" },
        hello: {
          auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
          features: { methods: ["update.run"] },
        },
      });
      const overlays = {
        snapshot: {
          approvalQueue: [{ id: "approval-1", request: { command: "echo proof" } }],
          approvalBusy: false,
          approvalCanGrant: true,
          approvalErrors: new Map(),
          updateAvailable: {
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.2",
            channel: "stable",
          },
        },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["overlays"];
      const selectionState = {
        selectedId: "main" as string | null,
        scopeId: null as string | null,
      };
      const selectionListeners = new Set<() => void>();
      const agentSelection = {
        state: selectionState,
        subscribe: (listener: () => void) => {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      } as unknown as ApplicationContext["agentSelection"];
      vi.stubGlobal("localStorage", createTestStorageMock());
      localStorage.setItem(
        ATTENTION_KEY,
        JSON.stringify({
          cronFailed: ["dismissed-cron"],
          modelAuthExpired: ["agent:writer\nold-provider"],
        }),
      );
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let now = 120_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const { element, store, trigger } = await mountAttention({
        agentSelection,
        gateway,
        overlays,
      });
      await waitForFast(() =>
        expect(
          store.entries.some(
            (entry) => entry.type === "attention" && entry.kind === "modelAuthExpired",
          ),
        ).toBe(true),
      );
      trigger.click();
      await waitForFast(() => expect(attention(element, "modelAuthExpired")).not.toBeNull());

      now = 200_000;
      emit("cron");
      invalidateModelAuthStatusRequests(client);
      emit("chat.metadata.changed");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));

      selectionState.selectedId = "writer";
      for (const listener of selectionListeners) {
        listener();
      }

      flush();
      expect(attention(element, "modelAuthExpired")).toBeNull();
      expect(attention(element, "cronFailed")).not.toBeNull();
      expect(attention(element, "updateAvailable")).not.toBeNull();
      expect(element.querySelector('[data-approval-id="approval-1"]')).not.toBeNull();

      await waitForFast(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "models.authStatus"),
        ).toHaveLength(3),
      );
      emit("cron");
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);
      switchedAuth.resolve(authStatus(2));
      await waitForFast(() => expect(authText(element)).toContain("writer"));
      const storedDismissals = localStorage.getItem(ATTENTION_KEY);

      now = 300_000;
      pendingCron.resolve(cronResponse("refreshed"));
      if (outcome === "success") {
        staleAuth.resolve(authStatus(3, "ok"));
      } else {
        staleAuth.reject(new Error("stale Main auth"));
      }
      await Promise.allSettled([pendingCron.promise, staleAuth.promise, switchedAuth.promise]);
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3),
      );
      flush();

      expect(authText(element)).toContain("writer");
      expect(localStorage.getItem(ATTENTION_KEY)).toBe(storedDismissals);
      expect(attention(element, "cronFailed")).not.toBeNull();
      expect(attention(element, "updateAvailable")).not.toBeNull();
      expect(element.querySelector('[data-approval-id="approval-1"]')).not.toBeNull();
    },
  );

  it("opens top-mounted attention downward and clears stale live automation alerts", async () => {
    const request = queuedResponses({
      "cron.list": [cronResponse("failed"), cronResponse()],
      "cron.status": [cronStatus(1), cronStatus(0)],
      "models.authStatus": [authStatus(1)],
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emit } = eventGateway(
      {
        client,
        phase: "connected",
        selfUser: { id: "alice", name: "Alice" },
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["openclaw.chat"] },
        },
        assistantAgentId: "main",
        sessionKey: "agent:main:main",
        lastError: null,
        lastErrorCode: null,
      },
      {
        gatewayUrl: "ws://gateway.test",
        token: "",
        bootstrapToken: "",
        password: "",
      },
    );
    const overlays = {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"];
    const agentSelection = selection("main");
    vi.stubGlobal("localStorage", createTestStorageMock());

    const { element, trigger } = await mountAttention({ gateway, overlays, agentSelection });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 10, 32, 32));
    trigger.click();
    await waitForFast(() => expect(attention(element, "cronFailed")).not.toBeNull());
    const panel = issues(element, "panel")!;
    expect(panel.style).toMatchObject({ top: "50px", bottom: "" });
    expect(panel.style.getPropertyValue("--sidebar-issues-panel-top")).toBe("50px");
    expect(
      Array.from(
        panel.querySelectorAll("header button"),
        (button) => button.getAttribute("aria-label") ?? button.textContent,
      ).some((label) => label?.includes("Ask OpenClaw")),
    ).toBe(false);

    const { custodianAlertStore } = await import("../pages/custodian/custodian-alert-store.ts");
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      const alertAction = panel.querySelector<HTMLButtonElement>(
        '[data-attention-kind="modelAuthExpired"] .sidebar-issues-panel__action:not(.sidebar-issues-panel__action--primary)',
      )!;
      expect(alertAction.textContent?.trim()).toBe("Ask OpenClaw");
      alertAction.click();
      await waitForFast(() =>
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: CUSTODIAN_PANEL_TOGGLE_EVENT, detail: { open: true } }),
        ),
      );
      expect(custodianAlertStore.alert?.id).toBe("modelAuthExpired:agent:main\nopenai");
      expect(issues(element, "panel")).toBeNull();
    } finally {
      custodianAlertStore.dismiss();
    }
    await openPanel(element, trigger);

    emit("cron");
    await waitForFast(() => expect(attention(element, "cronFailed")).toBeNull());
  });
});

describe("update attention", () => {
  it("hides an unhydrated campaign only while update status can be polled", () => {
    const overlaySnapshot = {
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
        channel: "beta",
        commitsBehind: 2,
      },
      updateSchedule: {
        channel: "beta",
        campaign: {
          state: "waiting-for-idle",
        },
      },
      updateCampaignStatusHydrated: false,
      updateRunning: false,
      updateStatusBanner: null,
    };
    const gatewaySnapshot = {
      client: {} as GatewayBrowserClient,
      phase: "connected" as const,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["update.status"] },
      },
    };
    const context = {
      gateway: { snapshot: gatewaySnapshot },
      overlays: { snapshot: overlaySnapshot },
    } as unknown as ApplicationContext;

    expect(resolveSidebarUpdateAttention(context)).toBeNull();

    gatewaySnapshot.hello.auth.scopes = ["operator.read"];
    expect(resolveSidebarUpdateAttention(context)).not.toBeNull();

    gatewaySnapshot.hello.auth.scopes = ["operator.admin"];
    overlaySnapshot.updateCampaignStatusHydrated = true;
    expect(resolveSidebarUpdateAttention(context)).not.toBeNull();
  });

  it("keeps restart reconciliation visible after update metadata clears", () => {
    const context = {
      gateway: { snapshot: { phase: "connected" } },
      overlays: {
        snapshot: {
          updateAvailable: null,
          updateSchedule: null,
          updateRunning: false,
          updateReconciliationPending: true,
          updateStatusBanner: null,
        },
      },
    } as unknown as ApplicationContext;

    expect(resolveSidebarUpdateAttention(context)).not.toBeNull();
  });
});
