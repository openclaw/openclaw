import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  createContext,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.tsx";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function conversationTarget(
  target: string,
  overrides: Partial<ConversationListItem> = {},
): ConversationListItem {
  return {
    conversationRef: `conv_${target}`,
    channel: "telegram",
    accountId: "default",
    kind: "group",
    target,
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...overrides,
  };
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

function directoryRequest(
  load: (
    params?: unknown,
  ) =>
    | { conversations: ConversationListItem[] }
    | Promise<{ conversations: ConversationListItem[] }>,
) {
  const fallback = createRequest();
  return vi.fn(async (method: string, params?: unknown) =>
    method === "conversations.list" ? load(params) : fallback(method),
  );
}

async function mountPage(
  request: (method: string, params?: unknown) => Promise<unknown> = createRequest(),
  options: { render?: boolean } = {},
) {
  const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
  const context = createContext(gateway, "writer");
  const page = createPage(context, options);
  await waitForCronPage(() => expect(page.cron.connected).toBe(true));
  return { page, gateway, context };
}

function digestJob(id = "daily-digest", overrides: Partial<CronJob> = {}) {
  return createCronViewJob(id, {
    configRevision: "rev-1",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Send the digest" },
    ...overrides,
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
    const { page } = await mountPage(request, { render: true });
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
    expect(request).toHaveBeenCalledWith("conversations.list", {
      agentId: "writer",
      channel: "telegram",
      limit: 100,
    });
    expect(optionsFor("#cron-failure-alert-to")).toEqual(["-100saved"]);
    expect(page.querySelector<HTMLInputElement>("#cron-failure-alert-to")?.value).toBe(
      "-100personal",
    );
  });

  it("rejects conversation targets from an earlier channel selection", async () => {
    const telegram = createDeferred<{ conversations: ConversationListItem[] }>();
    const request = directoryRequest((params) => {
      const channel = (params as { channel: string }).channel;
      if (channel === "telegram") {
        return telegram.promise;
      }
      return {
        conversations: [
          conversationTarget("channel:current", {
            conversationRef: "conv_discord_current",
            channel: "discord",
            kind: "channel",
          }),
        ],
      };
    });
    const { page } = await mountPage(request);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    page.patchForm({ deliveryChannel: "discord" });
    await waitForCronPage(() =>
      expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
        "channel:current",
      ]),
    );

    telegram.resolve({
      conversations: [conversationTarget("-100stale", { conversationRef: "conv_telegram_stale" })],
    });
    await Promise.resolve();
    expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
      "channel:current",
    ]);
  });

  it("keeps account and topic routing operator-authored without rediscovering cached targets", async () => {
    const request = directoryRequest(() => ({
      conversations: [
        conversationTarget("-100personal", { accountId: "personal" }),
        conversationTarget("-100work", { accountId: "work", threadId: "42" }),
      ],
    }));
    const { page } = await mountPage(request);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(2));
    page.patchForm({ deliveryAccountId: "work" });
    await page.settle();
    expect(request.mock.calls.filter(([method]) => method === "conversations.list")).toHaveLength(
      1,
    );
    expect(page.deliveryDirectory.conversations).toHaveLength(2);
    expect(page.cron.cronForm.deliveryAccountId).toBe("work");
    page.patchForm({ deliveryTo: "-100work" });
    expect(page.cron.cronForm.deliveryAccountId).toBe("work");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
    page.patchForm({ deliveryThreadId: "42" });
    page.patchForm({ deliveryTo: "-100new" });
    expect(page.cron.cronForm.deliveryAccountId).toBe("work");
    expect(page.cron.cronForm.deliveryThreadId).toBeUndefined();
  });

  it("drops an in-flight directory response after administrator access is lost", async () => {
    const pending = createDeferred<{ conversations: ConversationListItem[] }>();
    const request = directoryRequest(() => pending.promise);
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway, "writer"));

    await waitForCronPage(() => expect(page.cron.connected).toBe(true));
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    pending.resolve({
      conversations: [
        conversationTarget("-100private", {
          conversationRef: "conv_telegram_private",
          accountId: "private",
        }),
      ],
    });
    await Promise.resolve();

    expect(page.deliveryDirectory.conversations).toEqual([]);
  });

  it.each([
    { exit: "close", published: false },
    { exit: "save", published: false },
    { exit: "delete", published: false },
    { exit: "delete", published: true },
  ] as const)(
    "retires directory failures on $exit (published=$published)",
    async ({ exit, published }) => {
      const pending = createDeferred<{ conversations: ConversationListItem[] }>();
      const request = directoryRequest(() => pending.promise);
      const { page } = await mountPage(request, { render: published });
      const job = digestJob();
      if (exit === "delete") {
        page.selectJob(job);
      }
      if (exit === "save") {
        page.cron.cronCreateOpen = true;
      }
      page.patchForm({
        name: "Saved task",
        payloadText: "Send the digest",
        deliveryMode: "announce",
        deliveryChannel: "telegram",
        deliveryTo: "-100saved",
      });
      await waitForCronPage(() =>
        expect(request).toHaveBeenCalledWith("conversations.list", expect.anything()),
      );
      if (published) {
        pending.reject(new Error("temporary directory failure"));
        await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));
      }
      if (exit === "close") {
        page.closePanel();
      } else if (exit === "save") {
        page.submitForm();
        await waitForCronPage(() =>
          expect(request).toHaveBeenCalledWith("cron.add", expect.anything()),
        );
        await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));
      } else {
        vi.mocked(showConfirmDialog).mockResolvedValue(true);
        await page.removeJob(job);
        await waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
        expect(request).toHaveBeenCalledWith("cron.remove", { id: "daily-digest" });
      }
      if (!published) {
        pending.reject(new Error("late directory failure"));
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(page.deliveryDirectory.conversations).toEqual([]);
      expect(page.deliveryDirectory.error).toBeNull();
      if (published) {
        await waitForCronPage(() =>
          expect(page.querySelectorAll(".cron-suggestion").length).toBeGreaterThan(0),
        );
      }
    },
  );

  it("prioritizes scheduler errors and clears the directory error after retry", async () => {
    let calls = 0;
    const request = directoryRequest(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary directory failure");
      }
      return {
        conversations: [
          conversationTarget("-100recovered", {
            conversationRef: "conv_telegram_recovered",
            accountId: "work",
          }),
        ],
      };
    });
    const { page } = await mountPage(request, { render: true });
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));

    page.cron = { ...page.cron, cronError: "scheduler save failed" };
    page.refreshView();
    await page.settle();
    expect(page.textContent).toContain("scheduler save failed");
    expect(page.textContent).not.toContain("temporary directory failure");
    page.cron.cronError = null;

    page.patchForm({ deliveryChannel: "discord" });
    page.patchForm({ deliveryChannel: "telegram" });
    await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(1));

    expect(page.deliveryDirectory.error).toBeNull();
  });

  it("keeps recipient discovery when the deletion is rejected", async () => {
    // A rejected remove reports cronError without throwing; its editor still owns discovery.
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
    const { page } = await mountPage(request);
    const job = digestJob();
    page.selectJob(job);
    page.patchForm({ deliveryMode: "announce", deliveryChannel: "telegram" });
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("conversations.list", expect.anything()),
    );

    await page.removeJob(job);
    await waitForCronPage(() => expect(page.cron.cronError).toContain("cron.remove rejected"));

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
      const { page, gateway, context } = await mountPage(request);
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
    // Only editor generation changes here; page, connection, and admin scope survive.
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
    const { page } = await mountPage(request);
    const doomed = digestJob();
    const replacement = digestJob("weekly-digest", {
      configRevision: "rev-2",
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

  it.each(["save", "toggle"] as const)(
    "retires the pending directory when %s conflict recovery changes the channel",
    async (operation) => {
      const { page, directoryChannels, directories } = await startConflictRecovery(operation);
      await waitForCronPage(() => expect(page.cron.cronForm.deliveryChannel).toBe("discord"));
      await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram", "discord"]));
      expect(page.cron.cronForm.deliveryAccountId).toBe("default");
      directories[0]?.resolve({ conversations: [conversationTarget("-100stale")] });
      await Promise.resolve();
      expect(page.deliveryDirectory.error).toBeNull();
      expect(page.deliveryDirectory.conversations).toEqual([]);
      directories[1]?.resolve({ conversations: [conversationTarget("-100recovered")] });
      await waitForCronPage(() =>
        expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual([
          "-100recovered",
        ]),
      );
    },
  );
});

// A revision conflict replaces the form through cron.get while keeping its account unchanged.
async function startConflictRecovery(operation: "save" | "toggle" = "save") {
  const directories = [
    createDeferred<{ conversations: ConversationListItem[] }>(),
    createDeferred<{ conversations: ConversationListItem[] }>(),
  ];
  const directoryChannels: string[] = [];
  const editedJob = digestJob("digest", {
    delivery: { mode: "announce", channel: "telegram", to: "-100original", accountId: "default" },
  });
  const authoritativeJob = {
    ...editedJob,
    configRevision: "rev-2",
    delivery: {
      mode: "announce",
      channel: "discord",
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
  const { page } = await mountPage(request, { render: operation === "toggle" });
  page.selectJob(editedJob);
  await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram"]));

  if (operation === "save") {
    page.submitForm();
  } else {
    page.querySelector<HTMLInputElement>('[data-test-id="cron-toggle-enabled"] input')!.click();
  }
  await waitForCronPage(() => expect(request).toHaveBeenCalledWith("cron.get", { id: "digest" }));
  return { page, request, directories, directoryChannels };
}
