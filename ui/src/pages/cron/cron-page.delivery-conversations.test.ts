import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { click, expectCalls, inputValue } from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
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

type DirectoryResult = { conversations: ConversationListItem[] };
const pendingDirectory = () => createDeferred<DirectoryResult>();
const directoryResult = (...conversations: ConversationListItem[]) => ({ conversations });
const announce = { deliveryMode: "announce", deliveryChannel: "telegram" } as const;
const savedForm = {
  ...announce,
  name: "Saved task",
  payloadText: "Send the digest",
  deliveryTo: "-100saved",
};
function directoryRequest(load: (params?: unknown) => DirectoryResult | Promise<DirectoryResult>) {
  return cronRpc({ "conversations.list": load });
}

function waitForTargets(page: Awaited<ReturnType<typeof mountPage>>["page"], expected: string[]) {
  return waitForCronPage(() =>
    expect(page.deliveryDirectory.conversations.map((entry) => entry.target)).toEqual(expected),
  );
}

async function mountPage(
  request: (method: string, params?: unknown) => Promise<unknown> = createRequest(),
  options: { render?: boolean } = {},
) {
  const mounted = mountCronPage(request, { render: false, scopeId: "writer", ...options });
  await waitForCronPage(() => expect(mounted.page.cron.connected).toBe(true));
  return mounted;
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

it("keeps primary account directory targets out of failure-alert suggestions", async () => {
  const savedJob = createCronViewJob("saved-route", {
    delivery: { mode: "announce", channel: "telegram", to: "-100saved" },
  });
  const request = cronRpc({
    "cron.list": () => cronListResponse([savedJob]),
    "conversations.list": () =>
      directoryResult(
        conversationTarget("-100work", { accountId: "work" }),
        conversationTarget("-100personal", { accountId: "personal" }),
      ),
  });
  const { page } = await mountPage(request, { render: true });
  await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(1));
  page.selectJob(
    digestJob("editing-route", {
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
  expect(inputValue(page, "#cron-failure-alert-to")).toBe("-100personal");
});

it("keeps account and topic routing operator-authored without rediscovering cached targets", async () => {
  const request = directoryRequest(() =>
    directoryResult(
      conversationTarget("-100personal", { accountId: "personal" }),
      conversationTarget("-100work", { accountId: "work", threadId: "42" }),
    ),
  );
  const { page } = await mountPage(request);
  page.patchForm(announce);
  await waitForCronPage(() => expect(page.deliveryDirectory.conversations).toHaveLength(2));
  page.patchForm({ deliveryAccountId: "work" });
  await page.settle();
  expectCalls(request, ["conversations.list"], 1);
  expect(page.deliveryDirectory.conversations).toHaveLength(2);
  expect(page.cron.cronForm.deliveryAccountId).toBe("work");
  page.patchForm({ deliveryTo: "-100work" });
  const workRoute = { deliveryAccountId: "work", deliveryThreadId: undefined };
  expect(page.cron.cronForm).toMatchObject(workRoute);
  page.patchForm({ deliveryThreadId: "42" });
  page.patchForm({ deliveryTo: "-100new" });
  expect(page.cron.cronForm).toMatchObject(workRoute);
});

it("drops an in-flight directory response after administrator access is lost", async () => {
  const pending = pendingDirectory();
  const request = directoryRequest(() => pending.promise);
  const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
  gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
  const page = createPage(createContext(gateway, "writer"));
  await waitForCronPage(() => expect(page.cron.connected).toBe(true));
  page.patchForm(announce);
  gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
  pending.resolve(directoryResult(conversationTarget("-100private", { accountId: "private" })));
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
    const pending = pendingDirectory();
    const request = directoryRequest(() => pending.promise);
    const { page } = await mountPage(request, { render: published });
    const job = digestJob();
    if (exit === "delete") {
      page.selectJob(job);
    }
    if (exit === "save") {
      page.cron.cronCreateOpen = true;
    }
    page.patchForm(savedForm);
    await waitForCronPage(() => expectCalls(request, ["conversations.list"], 1));
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
    expect(page.deliveryDirectory).toMatchObject({ conversations: [], error: null });
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
    return directoryResult(conversationTarget("-100recovered", { accountId: "work" }));
  });
  const { page } = await mountPage(request, { render: true });
  page.patchForm(announce);
  await waitForCronPage(() => expect(page.deliveryDirectory.error).toContain("temporary"));

  page.cron.cronError = "scheduler save failed";
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
  const pending = pendingDirectory();
  const request = cronRpc({
    "conversations.list": () => pending.promise,
    "cron.remove": () => {
      throw new Error("cron.remove rejected");
    },
  });
  vi.mocked(showConfirmDialog).mockResolvedValue(true);
  const { page } = await mountPage(request);
  const job = digestJob();
  page.selectJob(job);
  page.patchForm(announce);
  await waitForCronPage(() => expectCalls(request, ["conversations.list"], 1));

  await page.removeJob(job);
  await waitForCronPage(() => expect(page.cron.cronError).toContain("cron.remove rejected"));
  expect(page.cron.cronEditingJob?.id).toBe("daily-digest");

  pending.resolve(directoryResult(conversationTarget("@ops-room")));
  await waitForTargets(page, ["@ops-room"]);
  expect(page.deliveryDirectory.error).toBeNull();
});

it.each([
  ["a reconnect", "reconnect"],
  ["an agent scope change", "scope"],
] as const)(
  "leaves the replacement page's directory alone when a save outlives %s",
  async (_label, rotation) => {
    const save = createDeferred<{ id: string }>();
    const staleDirectory = pendingDirectory();
    const freshDirectory = pendingDirectory();

    let directoryCalls = 0;
    const request = cronRpc({
      "cron.add": () => save.promise,
      "conversations.list": () => {
        directoryCalls += 1;
        return directoryCalls === 1 ? staleDirectory.promise : freshDirectory.promise;
      },
    });
    const { page, gateway, context } = await mountPage(request);
    page.cron.cronCreateOpen = true;
    page.patchForm(savedForm);
    await waitForCronPage(() => expect(directoryCalls).toBe(1));
    staleDirectory.resolve(directoryResult(conversationTarget("-100stale")));
    await waitForTargets(page, ["-100stale"]);

    page.submitForm();
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.add", expect.anything()),
    );

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
    page.patchForm(announce);
    await waitForCronPage(() => expect(directoryCalls).toBe(2));

    save.resolve({ id: "saved-1" });
    await waitForCronPage(() => expect(retiredState.cronCreateOpen).toBe(false));

    freshDirectory.resolve(directoryResult(conversationTarget("-100fresh")));
    await waitForTargets(page, ["-100fresh"]);
    expect(directoryCalls).toBe(2);
    expect(page.deliveryDirectory.error).toBeNull();
  },
);

it("preserves a replacement editor's directory when an earlier deletion lands", async () => {
  const removal = createDeferred<Record<string, never>>();
  const directories = [pendingDirectory(), pendingDirectory()];
  let directoryCalls = 0;

  const request = cronRpc({
    "conversations.list": () => {
      const pending = directories[Math.min(directoryCalls, directories.length - 1)];
      directoryCalls += 1;
      return pending?.promise;
    },
    "cron.remove": () => removal.promise,
  });
  vi.mocked(showConfirmDialog).mockResolvedValue(true);
  const { page } = await mountPage(request);
  const doomed = digestJob();
  const replacement = digestJob("weekly-digest", { configRevision: "rev-2" });

  page.selectJob(doomed);
  page.patchForm(announce);
  await waitForCronPage(() => expect(directoryCalls).toBe(1));
  directories[0]?.resolve(directoryResult(conversationTarget("-100doomed")));

  const removed = page.removeJob(doomed);
  await waitForCronPage(() =>
    expect(request).toHaveBeenCalledWith("cron.remove", { id: "daily-digest" }),
  );

  page.selectJob(replacement);
  page.patchForm(announce);
  await waitForCronPage(() => expect(directoryCalls).toBe(2));

  removal.resolve({});
  await removed;

  expect(page.cron.cronEditingJob?.id).toBe("weekly-digest");
  directories[1]?.resolve(directoryResult(conversationTarget("-100replacement")));
  await waitForTargets(page, ["-100replacement"]);
  expect(page.deliveryDirectory.error).toBeNull();
});

it.each(["save", "toggle"] as const)(
  "retires the pending directory when %s conflict recovery changes the channel",
  async (operation) => {
    const { page, directoryChannels, directories } = await startConflictRecovery(operation);
    await waitForCronPage(() => expect(page.cron.cronForm.deliveryChannel).toBe("discord"));
    await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram", "discord"]));
    expect(page.cron.cronForm.deliveryAccountId).toBe("default");
    directories[0]?.resolve(directoryResult(conversationTarget("-100stale")));
    await Promise.resolve();
    expect(page.deliveryDirectory).toMatchObject({ error: null, conversations: [] });
    directories[1]?.resolve(directoryResult(conversationTarget("-100recovered")));
    await waitForTargets(page, ["-100recovered"]);
  },
);
async function startConflictRecovery(operation: "save" | "toggle" = "save") {
  const directories = [pendingDirectory(), pendingDirectory()];
  const directoryChannels: string[] = [];
  const editedJob = digestJob("digest", {
    delivery: { mode: "announce", channel: "telegram", to: "-100original", accountId: "default" },
  });
  const authoritativeJob: CronJob = {
    ...editedJob,
    configRevision: "rev-2",
    delivery: {
      mode: "announce",
      channel: "discord",
      to: "-100authoritative",
      accountId: "default",
    },
  };

  const request = cronRpc({
    "conversations.list": (payload) => {
      const channel = (payload as { channel?: string } | undefined)?.channel ?? "";
      directoryChannels.push(channel);
      return directories[Math.min(directoryChannels.length - 1, directories.length - 1)]?.promise;
    },
    "cron.update": () => {
      throw Object.assign(new Error("cron job definition changed"), {
        details: { code: "CRON_JOB_CHANGED" },
      });
    },
    "cron.get": () => authoritativeJob,
  });
  const { page } = await mountPage(request, { render: operation === "toggle" });
  page.selectJob(editedJob);
  await waitForCronPage(() => expect(directoryChannels).toEqual(["telegram"]));

  if (operation === "save") {
    page.submitForm();
  } else {
    click(page, '[data-test-id="cron-toggle-enabled"] input');
  }
  await waitForCronPage(() => expect(request).toHaveBeenCalledWith("cron.get", { id: "digest" }));
  return { page, request, directories, directoryChannels };
}
