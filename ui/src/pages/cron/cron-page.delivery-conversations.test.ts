import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { DeliveryConversationsController } from "./delivery-conversations.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type CronTestPage = HTMLElement & {
  context: ApplicationContext;
  routeSearch: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  render: () => typeof nothing;
  cron: CronState;
  cronModelSuggestions: string[];
  deliveryDirectory: Pick<DeliveryConversationsController, "conversations" | "error">;
  patchForm: (patch: Partial<CronState["cronForm"]>) => void;
  closePanel: () => void;
  submitForm: () => void;
  selectJob: (job: CronJob) => void;
  removeJob: (job: CronJob) => Promise<void>;
};

function conversationTarget(target: string): ConversationListItem {
  return {
    conversationRef: `conv_${target}`,
    channel: "telegram",
    accountId: "default",
    kind: "group",
    target,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

function waitForCronPage(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

type TestGateway = ApplicationContext["gateway"] & {
  emitSnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

function createGateway(client: GatewayBrowserClient, connected: boolean): TestGateway {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents() {
      return () => undefined;
    },
    emitSnapshot(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  } as unknown as TestGateway;
}

function operatorHello(scopes: string[]): NonNullable<ApplicationGatewaySnapshot["hello"]> {
  return {
    type: "hello-ok",
    protocol: 4,
    auth: { role: "operator", scopes },
  };
}

function createContext(
  gateway: TestGateway,
  scopeId: string | null = "main",
  selectedId: string | null = scopeId,
): ApplicationContext {
  const subscribe = () => () => undefined;
  let selectionState = { selectedId, scopeId };
  const selectionListeners = new Set<(state: typeof selectionState) => void>();
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: { defaultId: "main", agents: [{ id: "main" }] },
        agentsLoading: false,
        agentsError: null,
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    channels: {
      state: {
        channelsSnapshot: null,
      },
      refresh: vi.fn(async () => undefined),
      subscribe,
    },
    runtimeConfig: {
      state: { configSnapshot: null },
      subscribe,
    },
    agentSelection: {
      get state() {
        return selectionState;
      },
      set(agentId: string | null) {
        selectionState = { selectedId: agentId, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      setScope(agentId: string | null) {
        selectionState = { ...selectionState, scopeId: agentId };
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      },
      subscribe(listener: (state: typeof selectionState) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function createPage(context: ApplicationContext, options: { render?: boolean } = {}): CronTestPage {
  const page = document.createElement("openclaw-cron-page") as CronTestPage;
  page.context = context;
  if (!options.render) {
    page.render = () => nothing;
  }
  document.body.append(page);
  return page;
}

function cronListResponse(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs: jobs.map((job) => ({
      configRevision: job.configRevision ?? `config-revision-${job.id}`,
      ...job,
    })),
    snapshotRevision: "cron-page-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function createRequest() {
  return vi.fn(async (method: string) => {
    if (method === "cron.status") {
      return { enabled: true, jobs: 0, triggersEnabled: true };
    }
    if (method === "cron.list") {
      return cronListResponse([]);
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, offset: 0, hasMore: false };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    return {};
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it("keeps primary account directory targets out of failure-alert suggestions", async () => {
    const savedJob = createCronViewJob("saved-route", {
      delivery: { mode: "announce", channel: "telegram", to: "-100saved" },
    });
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([savedJob]);
      }
      if (method === "conversations.list") {
        return {
          conversations: [
            { ...conversationTarget("-100work"), accountId: "work" },
            { ...conversationTarget("-100personal"), accountId: "personal" },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });
    await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(1));
    page.selectJob(
      createCronViewJob("editing-route", {
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Send the digest" },
        delivery: { mode: "announce", channel: "telegram", accountId: "work" },
        failureAlert: { channel: "telegram", accountId: "personal", to: "-100personal" },
      }),
    );

    const optionsFor = (selector: string) => {
      const input = page.querySelector<HTMLInputElement>(selector);
      expect(input).not.toBeNull();
      return Array.from(input?.list?.options ?? [], (option) => option.value);
    };
    await waitForCronPage(() => expect(optionsFor("#cron-delivery-to")).toContain("-100work"));
    expect(optionsFor("#cron-failure-alert-to")).toEqual(["-100saved"]);
    expect(page.querySelector<HTMLInputElement>("#cron-failure-alert-to")?.value).toBe(
      "-100personal",
    );
  });

  it("loads configured conversation targets for the selected announce channel", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_configured_group",
              channel: "telegram",
              accountId: "default",
              kind: "group",
              target: "-1009876543210",
              label: "Configured group",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });

    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(1));
    expect(request).toHaveBeenCalledWith("conversations.list", {
      agentId: "writer",
      channel: "telegram",
      limit: 100,
    });
    expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
      "-1009876543210",
    ]);
  });

  it("rejects conversation targets from an earlier channel selection", async () => {
    const telegram = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "conversations.list") {
        const channel = (params as { channel: string }).channel;
        if (channel === "telegram") {
          return telegram.promise;
        }
        return {
          conversations: [
            {
              conversationRef: "conv_discord_current",
              channel: "discord",
              accountId: "default",
              kind: "channel",
              target: "channel:current",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    page.patchForm({ deliveryChannel: "discord" });
    await waitForCronPage(() =>
      expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
        "channel:current",
      ]),
    );

    telegram.resolve({
      conversations: [
        {
          conversationRef: "conv_telegram_stale",
          channel: "telegram",
          accountId: "default",
          kind: "group",
          target: "-100stale",
          firstSeenAt: 0,
          lastSeenAt: 0,
        },
      ],
    });
    await Promise.resolve();
    expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
      "channel:current",
    ]);
  });

  it("filters a cached directory locally when the account changes", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_personal",
              channel: "telegram",
              accountId: "personal",
              kind: "group",
              target: "-100personal",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
            {
              conversationRef: "conv_telegram_work",
              channel: "telegram",
              accountId: "work",
              kind: "group",
              target: "-100work",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(2));

    page.patchForm({ deliveryAccountId: "work" });
    await page.updateComplete;

    expect(request.mock.calls.filter(([method]) => method === "conversations.list")).toHaveLength(
      1,
    );
    expect(page.deliveryDirectory.conversations).toHaveLength(2);
    expect(page.cron.cronForm.deliveryAccountId).toBe("work");
  });

  it("drops an in-flight directory response after administrator access is lost", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    pending.resolve({
      conversations: [
        {
          conversationRef: "conv_telegram_private",
          channel: "telegram",
          accountId: "private",
          kind: "group",
          target: "-100private",
          firstSeenAt: 0,
          lastSeenAt: 0,
        },
      ],
    });
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
  });

  it("keeps an explicit suggestion account without inferring topic routing", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_bound_topic",
              channel: "telegram",
              accountId: "bound-account",
              kind: "group",
              target: "-1009876543210",
              threadId: "42",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(1));

    page.patchForm({ deliveryAccountId: "bound-account" });
    page.patchForm({ deliveryTo: "-1009876543210" });

    expect(page.cron.cronForm.deliveryAccountId).toBe("bound-account");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
  });

  it("clears stale topic metadata when an explicitly authored target changes", async () => {
    const page = createPage(
      createContext(
        createGateway({ request: createRequest() } as unknown as GatewayBrowserClient, true),
        "writer",
      ),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryAccountId: "operator-account",
      deliveryTo: "-100old",
      deliveryThreadId: "42",
    });
    page.patchForm({ deliveryTo: "-100new" });

    expect(page.cron.cronForm.deliveryAccountId).toBe("operator-account");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
  });

  it("drops an in-flight directory failure after the editor closes", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const page = createPage(
      createContext(createGateway({ request } as unknown as GatewayBrowserClient, true), "writer"),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    page.closePanel();
    pending.reject(new Error("late directory failure"));
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("drops an in-flight directory failure after a successful save", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    const page = createPage(
      createContext(createGateway({ request } as unknown as GatewayBrowserClient, true), "writer"),
    );

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.cron.cronCreateOpen = true;
    page.patchForm({
      name: "Saved task",
      payloadText: "Send the digest",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "-100saved",
    });
    page.submitForm();
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.add", expect.anything()),
    );
    await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));

    pending.reject(new Error("late directory failure"));
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("clears a recipient directory error after a successful retry", async () => {
    let calls = 0;
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary directory failure");
        }
        return {
          conversations: [
            {
              conversationRef: "conv_telegram_recovered",
              channel: "telegram",
              accountId: "work",
              kind: "group",
              target: "-100recovered",
              firstSeenAt: 0,
              lastSeenAt: 0,
            },
          ],
        };
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));

    page.patchForm({ deliveryChannel: "discord" });
    page.patchForm({ deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(1));

    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("keeps scheduler errors visible over recipient directory errors", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        throw new Error("temporary directory failure");
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));
    page.cron = { ...page.cron, cronError: "scheduler save failed" };
    page.requestUpdate();
    await page.updateComplete;

    expect(page.textContent).toContain("scheduler save failed");
    expect(page.textContent).not.toContain("temporary directory failure");
  });

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ phase: "stopped" });
    // A real reconnect arrives with a new Gateway client; the model catalog cache is
    // scoped per client, so reusing the first client would replay its pending read.
    gateway.emitSnapshot({
      phase: "connected",
      client: { request } as unknown as GatewayBrowserClient,
    });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });

  it("drops an in-flight directory failure after the selected task is deleted", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      return fallbackRequest(method);
    });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    const job = createCronViewJob("daily-digest", {
      configRevision: "rev-1",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the digest" },
    });
    page.selectJob(job);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("conversations.list", expect.anything()),
    );

    await page.removeJob(job);
    await waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
    expect(request).toHaveBeenCalledWith("cron.remove", { id: "daily-digest" });

    pending.reject(new Error("late directory failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("keeps recipient discovery when the deletion is rejected", async () => {
    // `cron.remove` failing is reported through `cronError`, not thrown, so the
    // editor stays open. Retiring discovery there would strand it: nothing
    // reloads suggestions until another channel/agent change or a reopen.
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        return pending.promise;
      }
      if (method === "cron.remove") {
        throw new Error("cron.remove rejected");
      }
      return fallbackRequest(method);
    });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    const job = createCronViewJob("daily-digest", {
      configRevision: "rev-1",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the digest" },
    });
    page.selectJob(job);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("conversations.list", expect.anything()),
    );

    await page.removeJob(job);
    await waitForCronPage(() => expect(page.cron.cronError).toContain("cron.remove rejected"));

    // The task survived, so its editor is still the discovery owner.
    expect(page.cron.cronEditingJob?.id).toBe("daily-digest");

    // A directory response that lands after the failed delete still publishes
    // into the editor that asked for it.
    pending.resolve({ conversations: [conversationTarget("@ops-room")] });
    await waitForCronPage(() =>
      expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
        "@ops-room",
      ]),
    );
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("clears a published directory error when the selected task is deleted", async () => {
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        throw new Error("temporary directory failure");
      }
      return fallbackRequest(method);
    });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    const job = createCronViewJob("daily-digest", {
      configRevision: "rev-1",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the digest" },
    });
    page.selectJob(job);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));

    await page.removeJob(job);

    await waitForCronPage(() => expect(page.deliveryDirectory.error).toBeNull());
    expect(page.deliveryDirectory.conversations).toEqual([]);
    // The published failure would otherwise survive onto the overview and
    // suppress the starter automations shown for an empty scheduler.
    await waitForCronPage(() =>
      expect(page.querySelectorAll(".cron-suggestion").length).toBeGreaterThan(0),
    );
  });

  it.each([
    ["a reconnect", "reconnect"],
    ["an agent scope change", "scope"],
  ] as const)(
    "leaves the replacement page's directory alone when a save outlives %s",
    async (_label, rotation) => {
      const save = createDeferred<{ id: string }>();
      const staleDirectory = createDeferred<{ conversations: ConversationListItem[] }>();
      const freshDirectory = createDeferred<{ conversations: ConversationListItem[] }>();
      const fallbackRequest = createRequest();
      let directoryCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.add") {
          return save.promise;
        }
        if (method === "conversations.list") {
          directoryCalls += 1;
          return directoryCalls === 1 ? staleDirectory.promise : freshDirectory.promise;
        }
        return fallbackRequest(method);
      });
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const context = createContext(gateway, "writer");
      const page = createPage(context);

      await waitForCronPage(() => expect(page.cron.connected).toBe(true));
      page.cron.cronCreateOpen = true;
      page.patchForm({
        name: "Saved task",
        payloadText: "Send the digest",
        deliveryMode: "announce",
        deliveryChannel: "telegram",
        deliveryTo: "-100saved",
      });
      await waitForCronPage(() => expect(directoryCalls).toBe(1));
      staleDirectory.resolve({ conversations: [conversationTarget("-100stale")] });
      await waitForCronPage(() =>
        expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
          "-100stale",
        ]),
      );

      page.submitForm();
      await waitForCronPage(() =>
        expect(request).toHaveBeenCalledWith("cron.add", expect.anything()),
      );

      // A reconnect rotates page state and connection scope; an agent scope
      // change rotates only the page state on the same live connection.
      const retiredState = page.cron;
      if (rotation === "reconnect") {
        gateway.emitSnapshot({ phase: "stopped" });
        gateway.emitSnapshot({
          phase: "connected",
          client: { request } as unknown as GatewayBrowserClient,
        });
      } else {
        context.agentSelection.setScope("reader");
      }
      await waitForCronPage(() => expect(page.cron).not.toBe(retiredState));
      page.cron.cronCreateOpen = true;
      page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
      await waitForCronPage(() => expect(directoryCalls).toBe(2));

      save.resolve({ id: "saved-1" });
      // The retired save runs its own continuation to completion, which is what
      // used to clear the replacement page's cache and advance its generation.
      await waitForCronPage(() => expect(retiredState.cronCreateOpen).toBe(false));

      freshDirectory.resolve({ conversations: [conversationTarget("-100fresh")] });
      await waitForCronPage(() =>
        expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
          "-100fresh",
        ]),
      );
      expect(directoryCalls).toBe(2);
      expect(page.deliveryDirectory.error).toBeNull();
    },
  );

  it("preserves a replacement editor's directory when an earlier deletion lands", async () => {
    // The page, the connection, and the admin scope all survive a task
    // deletion, so none of them can distinguish "the editor that asked for this
    // deletion exited" from "a different editor owns discovery now". Only the
    // editor generation captured before the delete can.
    const removal = createDeferred<Record<string, never>>();
    const directories = [
      createDeferred<{ conversations: ConversationListItem[] }>(),
      createDeferred<{ conversations: ConversationListItem[] }>(),
    ];
    let directoryCalls = 0;
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "conversations.list") {
        const pending = directories[Math.min(directoryCalls, directories.length - 1)];
        directoryCalls += 1;
        return pending?.promise;
      }
      if (method === "cron.remove") {
        return removal.promise;
      }
      return fallbackRequest(method);
    });
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    const doomed = createCronViewJob("daily-digest", {
      configRevision: "rev-1",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the digest" },
    });
    const replacement = createCronViewJob("weekly-digest", {
      configRevision: "rev-2",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the weekly digest" },
    });

    page.selectJob(doomed);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(directoryCalls).toBe(1));
    directories[0]?.resolve({ conversations: [conversationTarget("-100doomed")] });

    const removed = page.removeJob(doomed);
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.remove", { id: "daily-digest" }),
    );

    // A replacement editor opens while `cron.remove` is still in flight.
    page.selectJob(replacement);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(directoryCalls).toBe(2));

    removal.resolve({});
    await removed;

    // The deletion's continuation now sees a different editing job, which it
    // would otherwise read as its own confirmed exit.
    expect(page.cron.cronEditingJob?.id).toBe("weekly-digest");
    directories[1]?.resolve({ conversations: [conversationTarget("-100replacement")] });
    await waitForCronPage(() =>
      expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
        "-100replacement",
      ]),
    );
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("re-reads the recipient directory when conflict recovery replaces the route", async () => {
    // Revision-conflict recovery loads the authoritative definition into the
    // open editor and still reports `saved: false`, so the post-save resettle
    // never runs. The sending account is applied to cached rows locally, so a
    // recovery that only moves the channel leaves every Telegram target
    // selectable on the recovered Discord route unless the cache is retired.
    const { page, directoryChannels, directories } = await startConflictRecovery({
      recoveredChannel: "discord",
    });

    await waitForCronPage(() => expect(page.cron.cronForm.deliveryChannel).toBe("discord"));
    await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram", "discord"]));
    expect(page.cron.cronForm.deliveryAccountId).toBe("default");
    expect(page.deliveryDirectory.conversations).toEqual([]);

    directories[1]?.resolve({ conversations: [conversationTarget("-100recovered")] });
    await waitForCronPage(() =>
      expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
        "-100recovered",
      ]),
    );
  });

  it("drops an in-flight directory response after conflict recovery replaces the route", async () => {
    // The old route's read is still outstanding when recovery lands; without
    // retiring it, it publishes onto the route that replaced it.
    const { page, directoryChannels, directories } = await startConflictRecovery({
      recoveredChannel: "discord",
      resolveFirstDirectory: false,
    });

    await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram", "discord"]));

    directories[0]?.resolve({ conversations: [conversationTarget("-100stale")] });
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("keeps the recipient directory when conflict recovery preserves the route", async () => {
    // A rejected save that leaves the route in place must not re-read the
    // Gateway: the cached directory still answers for that exact channel and
    // agent, so retrying a save cannot turn into a discovery loop.
    const { page, directoryChannels } = await startConflictRecovery({
      recoveredChannel: "telegram",
    });

    await waitForCronPage(() => expect(page.cron.cronError).toContain("changed on the Gateway"));
    expect(directoryChannels).toEqual(["telegram"]);
    expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
      "-100original",
    ]);
  });
});

/**
 * Drives one editor through a `CRON_JOB_CHANGED` save: the editor opens on a
 * Telegram announce route, its directory read is answered, and the retry is
 * refused so `cron.get` replaces the form with an authoritative definition on
 * `recoveredChannel` under the same `default` account.
 */
async function startConflictRecovery(options: {
  recoveredChannel: string;
  resolveFirstDirectory?: boolean;
}) {
  const directories = [
    createDeferred<{ conversations: ConversationListItem[] }>(),
    createDeferred<{ conversations: ConversationListItem[] }>(),
  ];
  const directoryChannels: string[] = [];
  const editedJob = createCronViewJob("digest", {
    configRevision: "rev-1",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Send the digest" },
    delivery: { mode: "announce", channel: "telegram", to: "-100original", accountId: "default" },
  } as Partial<CronJob>);
  const authoritativeJob = {
    ...editedJob,
    configRevision: "rev-2",
    delivery: {
      mode: "announce",
      channel: options.recoveredChannel,
      to: "-100authoritative",
      accountId: "default",
    },
  } as CronJob;
  const fallbackRequest = createRequest();
  const request = vi.fn(async (method: string, payload?: unknown) => {
    if (method === "conversations.list") {
      const channel = (payload as { channel?: string } | undefined)?.channel ?? "";
      directoryChannels.push(channel);
      return directories[Math.min(directoryChannels.length - 1, directories.length - 1)]?.promise;
    }
    if (method === "cron.update") {
      throw Object.assign(new Error("cron job definition changed"), {
        details: { code: "CRON_JOB_CHANGED" },
      });
    }
    if (method === "cron.get") {
      return authoritativeJob;
    }
    return fallbackRequest(method);
  });
  const page = createPage(
    createContext(createGateway({ request } as unknown as GatewayBrowserClient, true), "writer"),
  );

  await waitForCronPage(() => expect(page.cron.connected).toBe(true));
  page.selectJob(editedJob);
  await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram"]));
  if (options.resolveFirstDirectory !== false) {
    directories[0]?.resolve({ conversations: [conversationTarget("-100original")] });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(1));
  }

  page.submitForm();
  await waitForCronPage(() => expect(request).toHaveBeenCalledWith("cron.get", { id: "digest" }));
  return { page, request, directories, directoryChannels };
}
