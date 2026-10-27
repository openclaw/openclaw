/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createMobileRootContentFixture as rootContent } from "../chat-mobile-host.test-support.ts";
import { SessionAutomationMobileList } from "./chat-automation-mobile.tsx";
import { ChatDetailsMobileContent } from "./chat-details-mobile-content.tsx";
import {
  ChatSummaryAutomations,
  createSessionAutomationInventory,
} from "./chat-summary-automations.tsx";

type Page = CronJobsListResult<CronCompactJob>;

const job = (overrides: Partial<CronCompactJob> = {}): CronCompactJob => ({
  id: "summary-job",
  name: "Check the task",
  agentId: "ops",
  enabled: true,
  updatedAtMs: 1,
  nextRunAt: null,
  nextRunAtMs: null,
  scheduleKind: "every",
  schedule: { kind: "every", everyMs: 600_000 },
  lastRunAt: null,
  lastRunAtMs: null,
  lastRunStatus: null,
  lastRunError: null,
  ...overrides,
});

const page = (jobs: CronCompactJob[] = [], overrides: Partial<Page> = {}): Page => ({
  jobs,
  snapshotRevision: "fixture-1",
  offset: 0,
  limit: 50,
  total: jobs.length,
  hasMore: false,
  nextOffset: null,
  ...overrides,
});

function sequence(...pages: (Page | Promise<Page>)[]) {
  const request = createGatewayRequestMock();
  pages.forEach((response) => request.mockResolvedValueOnce(response));
  return request;
}
const jobsRequest = (...jobs: CronCompactJob[]) => sequence(page(jobs));
const hello = (scopes: string[]) => ({
  type: "hello-ok" as const,
  protocol: 4,
  auth: { role: "operator" as const, scopes },
});
const eventJob = (updatedAtMs: number, state: Record<string, unknown>) => ({
  id: "summary-job",
  name: "Check the task",
  agentId: "ops",
  enabled: true,
  updatedAtMs,
  state,
});
async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}
function source(request = jobsRequest(job()), offline = false, scopes = ["operator.read"]) {
  return {
    request,
    ...createApplicationGateway({
      ...createApplicationGateway().gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: offline ? "offline" : "connected",
      hello: hello(scopes),
      assistantAgentId: "ops",
      sessionKey: "agent:ops:task",
    }),
  };
}

function mobile(request: ReturnType<typeof sequence>, overview = false) {
  const current = source(request);
  const view = mountSolid(() => {
    let host!: HTMLElement;
    const props = { gateway: current.gateway, sessionKey: "agent:ops:task", presented: true };
    const inventory = createSessionAutomationInventory(props, () => host);
    return (
      <section ref={(element) => (host = element)}>
        {inventory.lifecycle}
        {!overview && <output>{inventory.loaded() ? inventory.total() : "unknown"}</output>}
        <SessionAutomationMobileList inventory={inventory} basePath="" onOpenAutomation={vi.fn()} />
        {overview && (
          <ChatDetailsMobileContent
            details={{
              sessionKey: props.sessionKey,
              selectedSession: { key: props.sessionKey, kind: "direct" },
              currentAgentId: "ops",
              messages: [],
            }}
            presented
            page={{
              kind: "root",
              content: {
                ...rootContent(),
                automations: { inventory, summary: { label: "Automations" } },
              },
            }}
          />
        )}
      </section>
    );
  });
  return { ...current, ...view };
}
function component(
  request = jobsRequest(job()),
  presented = true,
  offline = false,
  scopes = ["operator.read"],
) {
  const current = source(request, offline, scopes);
  type Props = Parameters<typeof ChatSummaryAutomations>[0];
  const [props, setProps] = createSignal<Props>({
    gateway: current.gateway,
    sessionKey: "agent:ops:task",
    presented,
  });
  const view = mountSolid(() => <ChatSummaryAutomations {...props()} />);
  const element = view.container.querySelector<HTMLElement>("openclaw-chat-summary-automations")!;
  return {
    ...current,
    request,
    ...view,
    element,
    find: element.querySelector.bind(element),
    ready: (text = "Check the task") =>
      waitForSolid(() => {
        expect(element.textContent).toContain(text);
        expect(element.querySelector('[aria-busy="false"]')).not.toBeNull();
      }),
    empty: () =>
      waitForSolid(() => expect(element.querySelector(".chat-summary__automations")).toBeNull()),
    cron: (action = "updated", payload: Record<string, unknown> = {}) =>
      current.publishEvent({ type: "event", event: "cron", payload: { ...payload, action } }),
    update: (next: Partial<Props>) => {
      setProps((previous) => ({ ...previous, ...next }));
      flush();
    },
  };
}

afterEach(() => document.body.replaceChildren());

it.each([false, true])("coalesces hidden refreshes: %s", async (hiddenEvents) => {
  const pending = createDeferred<Page>();
  const current = component(sequence(pending.promise).mockResolvedValue(page([job()])));
  flush();
  current.publish({ ...current.gateway.snapshot });
  expect(current.request).toHaveBeenCalledTimes(1);
  pending.resolve(page([job()]));
  await current.ready();
  current.publish({ ...current.gateway.snapshot });
  expect(current.request).toHaveBeenCalledTimes(1);
  current.update({ presented: false });
  if (hiddenEvents) {
    current.cron();
    current.cron();
    flush();
    expect(current.request).toHaveBeenCalledTimes(1);
  }
  current.update({ presented: true });
  await current.ready();
  expect(current.request).toHaveBeenCalledTimes(2);
  if (!hiddenEvents) {
    current.cron();
    await current.ready();
    expect(current.request).toHaveBeenCalledTimes(3);
  }
  current.unmount();
  current.cron();
  current.publish(current.gateway.snapshot);
  flush();
  expect(current.request).toHaveBeenCalledTimes(hiddenEvents ? 2 : 3);
});

it.each([false, true])(
  "drains one trailing inventory after cron events arrive during a read (hidden=%s)",
  async (hidden) => {
    const pending = createDeferred<Page>();
    const current = component(
      sequence(page([job()]), pending.promise, page([job({ name: "Current automation" })])),
    );
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      await current.ready();
      current.cron();
      current.cron();
      current.cron();
      current.cron();
      expect(current.request).toHaveBeenCalledTimes(2);
      if (hidden) {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }

      pending.resolve(page([job({ name: "Older automation" })]));
      if (hidden) {
        await current.ready("Older automation");
        expect(current.request).toHaveBeenCalledTimes(2);
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await current.ready("Current automation");
      expect(current.request).toHaveBeenCalledTimes(3);
    } finally {
      current.unmount();
      visibility.mockRestore();
    }
  },
);

it("updates a held automation's runtime state without rereading its inventory", async () => {
  const current = component(sequence(page([job()])).mockResolvedValue(page([job()])));
  await current.ready();
  current.cron("started", {
    jobId: "summary-job",
    job: eventJob(2, { runningAtMs: 2 }),
  });
  await current.ready("Running");
  expect(current.request).toHaveBeenCalledTimes(1);

  current.cron("finished", {
    jobId: "summary-job",
    job: eventJob(3, { lastRunAtMs: 3, lastRunStatus: "ok", nextRunAtMs: 600_003 }),
  });
  await current.ready("Every 10 minutes");
  expect(current.element.textContent).not.toContain("Running");
  expect(current.request).toHaveBeenCalledTimes(1);
  current.unmount();
});

it("keeps the last meaningful result while a quiet check advances freshness", async () => {
  const checkedAt = Date.now() - 120_000;
  const result = {
    outcome: "blocked" as const,
    summary: "Waiting for Windows CI",
    atMs: checkedAt,
  };
  const current = component(
    jobsRequest(job({ lastMeaningfulResult: result, lastRunAtMs: checkedAt, lastDurationMs: 500 })),
  );
  await current.ready("Waiting for Windows CI");
  const before = current.find("time")?.getAttribute("datetime");
  current.cron("finished", {
    jobId: "summary-job",
    durationMs: 1_000,
    job: eventJob(checkedAt + 60_000, {
      lastRunAtMs: checkedAt + 60_000,
      lastDurationMs: 1_000,
      lastRunStatus: "ok",
      lastMeaningfulResult: result,
    }),
  });
  await current.ready("Checked");
  await waitForSolid(() => {
    expect(current.find("time")?.getAttribute("datetime")).toBe(
      new Date(checkedAt + 61_000).toISOString(),
    );
  });
  expect(current.find("time")?.getAttribute("datetime")).not.toBe(before);
  expect(current.element.textContent).toContain("Waiting for Windows CI");
  expect(current.request).toHaveBeenCalledTimes(1);
  current.unmount();
});

it("admits only presented session-scoped reads and uses the existing automation destination", async () => {
  const pending = createDeferred<Page>();
  const current = component(sequence(pending.promise), false);
  const { element, find } = current;
  flush();
  expect(current.request).not.toHaveBeenCalled();
  current.update({ presented: true });
  expect(element.textContent?.trim()).toBe("");
  expect(element.textContent).not.toContain("No automations");
  expect(current.request).toHaveBeenCalledWith(
    "cron.list",
    expect.objectContaining({
      sessionKey: "agent:ops:task",
      sessionAgentId: "ops",
      includeDisabled: true,
      includeDeliveryPreviews: false,
      compact: true,
      limit: 50,
      offset: 0,
      enabled: "all",
      sortBy: "name",
      sortDir: "asc",
    }),
  );
  const fullTitle = "A long automation title that must remain unabridged and accessible";
  pending.resolve(page([job({ name: fullTitle })]));
  await current.ready(fullTitle);
  const link = find<HTMLAnchorElement>(".chat-summary__automation")!;
  expect(link.getAttribute("href")).toBe("/automations?job=summary-job");
  expect(link.textContent).toContain("Every 10 minutes");
  expect(find(".chat-summary__automation-title")?.textContent?.trim()).toBe(fullTitle);
  expect(find<HTMLDetailsElement>('[data-details-group="automations"]')?.open).toBe(true);
  expect(link.querySelector("svg")).not.toBeNull();
  const onNavigate = vi.fn();
  current.update({ onNavigate });
  link.click();
  expect(onNavigate).toHaveBeenCalledWith("summary-job");
  expect(current.request).toHaveBeenCalledTimes(1);
});

it("omits confirmed-empty sections and preserves manual collapse until the content disappears", async () => {
  const current = component(sequence(page()).mockResolvedValue(page([job()])));
  const { find } = current;
  flush();
  await current.empty();
  expect(find("summary")).toBeNull();
  current.cron("added");
  await current.ready();
  const group = find<HTMLDetailsElement>("details")!;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  current.cron();
  flush();
  await current.ready();
  expect(find("details")).toBe(group);
  expect(group.open).toBe(false);
  const link = find(".chat-summary__automation");
  current.update({ presented: false });
  current.update({ presented: true });
  await current.ready();
  expect(find("details")).toBe(group);
  expect(group.open).toBe(false);
  expect(find(".chat-summary__automation")).toBe(link);
  current.request.mockResolvedValueOnce(page());
  current.cron("removed");
  await current.empty();
  expect(find("summary")).toBeNull();
  current.cron("added");
  await current.ready();
  expect(find<HTMLDetailsElement>("details")?.open).toBe(true);
});

it.each([false, true])(
  "recovers inventory reads without changing paused jobs: loaded=%s",
  async (loaded) => {
    vi.useFakeTimers();
    const request = createGatewayRequestMock();
    if (loaded) {
      request.mockResolvedValueOnce(page([job({ enabled: false })]));
    }
    request.mockRejectedValueOnce(new Error("Temporary inventory failure"));
    const current = component(request);
    try {
      await advance();
      if (loaded) {
        current.cron();
        await advance();
        expect(current.element.textContent).toContain("Paused");
      }
      expect(current.find(".chat-summary__automation-retry")).toBeNull();
      const count = request.mock.calls.length;
      request.mockResolvedValue(page([job({ name: "Recovered automation", enabled: false })]));
      current.publish({ ...current.gateway.snapshot });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(request).toHaveBeenCalledTimes(count);
      await advance(1);
      expect(current.element.textContent).toContain("Recovered automation");
      expect(current.element.textContent).toContain("Paused");
      expect(current.find(".chat-summary__automation-retry")).toBeNull();
      expect(request).toHaveBeenCalledTimes(count + 1);
      expect(request.mock.calls.every(([method]) => method === "cron.list")).toBe(true);
    } finally {
      current.unmount();
      vi.useRealTimers();
    }
  },
);

it.each(["retry", "event", "reconnect"] as const)(
  "retires refused automation content until a new %s read",
  async (recovery) => {
    vi.useFakeTimers();
    const request = createGatewayRequestMock().mockResolvedValueOnce(
      page([job({ enabled: false })]),
    );
    const current = component(request);
    try {
      await advance();
      expect(current.element.textContent).toContain("Check the task");
      request.mockRejectedValue(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Read authority revoked" }),
      );
      current.cron();
      await advance();
      expect(current.element.textContent).not.toContain("Check the task");
      expect(current.find(".chat-summary__automation-more")).toBeNull();
      current.publish({ ...current.gateway.snapshot });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      request.mockResolvedValue(page([job({ name: "Authorized automation", enabled: false })]));
      if (recovery === "retry") {
        current.find<HTMLButtonElement>(".chat-summary__automation-retry")!.click();
      } else if (recovery === "event") {
        current.cron();
      } else {
        const snapshot = current.gateway.snapshot;
        current.publish({ ...snapshot, phase: "reconnecting" });
        current.publish(snapshot);
      }
      await advance();
      expect(current.element.textContent).toContain("Authorized automation");
      expect(current.element.textContent).toContain("Paused");
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls.every(([method]) => method === "cron.list")).toBe(true);
    } finally {
      current.unmount();
      vi.useRealTimers();
    }
  },
);

it.each(["hidden", "offline", "denied", "unmounted"] as const)(
  "retires pending inventory recovery when %s",
  async (boundary) => {
    vi.useFakeTimers();
    const current = component(
      createGatewayRequestMock().mockRejectedValue(new Error("Temporary failure")),
    );
    try {
      await advance();
      if (boundary === "hidden") {
        current.update({ presented: false });
      } else if (boundary === "offline") {
        current.publish({ ...current.gateway.snapshot, phase: "reconnecting" });
      } else if (boundary === "denied") {
        current.publish({
          ...current.gateway.snapshot,
          hello: hello([]),
        });
      } else {
        current.unmount();
      }
      const count = current.request.mock.calls.length;
      await advance(60_000);
      expect(current.request).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (boundary !== "unmounted") {
        current.unmount();
      }
      vi.useRealTimers();
    }
  },
);

it.each([false, true])("restores retry focus: moved=%s", async (moved) => {
  const pending = createDeferred<Page>();
  const current = component(
    createGatewayRequestMock()
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "private server detail" }),
      )
      .mockReturnValueOnce(pending.promise),
  );
  const { element, find } = current;
  const sibling = document.createElement("details");
  document.body.append(sibling);
  await current.ready("Couldn't load automations.");
  expect(element.textContent).not.toContain("private server detail");
  const retry = find<HTMLButtonElement>(".chat-summary__automation-retry")!;
  expect(retry.textContent?.trim()).toBe("Retry");
  retry.focus();
  retry.click();
  flush();
  expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute("aria-disabled")).toBe("true");
  retry.click();
  expect(current.request).toHaveBeenCalledTimes(2);
  const composer = document.createElement("textarea");
  composer.value = "Keep my draft";
  document.body.append(composer);
  if (moved) {
    composer.focus();
  }
  pending.resolve(moved ? page() : page([job()]));
  await (moved ? current.empty() : current.ready());
  flush();
  expect(document.activeElement).toBe(moved ? composer : find(".chat-summary__automation"));
  expect(composer.value).toBe("Keep my draft");
  expect(sibling.open).toBe(false);
});

it("fences late pages on session and same-client reconnect boundaries", async () => {
  const retired = createDeferred<Page>();
  const reconnectRetired = createDeferred<Page>();
  const latest = createDeferred<Page>();
  const current = component(sequence(retired.promise, reconnectRetired.promise, latest.promise));
  const { element } = current;
  flush();
  current.update({ sessionKey: "agent:ops:second" });
  const snapshot = current.gateway.snapshot;
  current.publish({ ...snapshot, phase: "reconnecting" });
  current.publish(snapshot);
  flush();
  expect(current.request).toHaveBeenCalledTimes(3);
  expect(current.request.mock.calls[2]?.[1]).toMatchObject({ sessionKey: "agent:ops:second" });
  latest.resolve(page([job({ name: "Current session" })]));
  await current.ready("Current session");
  retired.resolve(page([job({ name: "Wrong session" })]));
  reconnectRetired.resolve(page([job({ name: "Retired connection" })]));
  await retired.promise;
  await reconnectRetired.promise;
  flush();
  expect(element.textContent).toContain("Current session");
  expect(element.textContent).not.toMatch(/Wrong session|Retired connection/);
});

it.each([false, true])("preserves offline inventory: loaded=%s", async (loaded) => {
  const current = component(undefined, true, !loaded);
  const { element } = current;
  if (loaded) {
    await current.ready();
    current.publish({ ...current.gateway.snapshot, phase: "offline", client: null });
  }
  flush();
  if (loaded) {
    expect(element.textContent).toContain("Check the task");
  } else {
    expect(element.textContent?.trim()).toBe("");
  }
  expect(element.textContent).not.toContain("No automations");
  if (loaded) {
    expect(element.textContent).not.toContain("Reconnect to load");
  }
  current.update({ sessionKey: loaded ? "agent:ops:other" : "unresolved-session" });
  await waitForSolid(() => expect(element.textContent).not.toContain("Check the task"));
  if (!loaded) {
    current.publish({ ...current.gateway.snapshot, phase: "connected" });
    flush();
    expect(element.textContent?.trim()).toBe("");
    expect(current.request).not.toHaveBeenCalled();
  }
});

it("uses the inventory continuation rather than silently dropping additional automations", async () => {
  const current = component(
    sequence(
      page([job({ name: "First automation", enabled: false })], {
        total: 2,
        hasMore: true,
        nextOffset: 1,
      }),
      page([job({ id: "second", name: "Second automation", runningAtMs: 42 })], {
        offset: 1,
        total: 2,
      }),
    ),
  );
  const { element, find } = current;
  await current.ready("First automation");
  expect(element.textContent).toContain("Paused");
  find<HTMLButtonElement>(".chat-summary__automation-more")!.click();
  await current.ready("Second automation");
  expect(current.request.mock.calls[1]?.[1]).toMatchObject({
    offset: 1,
    sessionKey: "agent:ops:task",
    sessionAgentId: "ops",
  });
  expect(element.querySelectorAll(".chat-summary__automation")).toHaveLength(2);
  expect(element.textContent).toContain("Running");
  expect(find(".chat-summary__automation-more")).toBeNull();
});

it("omits automation reads and retry UI without read authority", async () => {
  const current = component(undefined, true, false, [
    "operator.sessions.read",
    "operator.sessions.write",
  ]);
  await current.empty();
  current.cron();
  window.dispatchEvent(new Event("focus"));
  current.update({ presented: false });
  current.update({ presented: true });
  expect(current.request).not.toHaveBeenCalled();
  expect(current.element.textContent).toBe("");
});

it.each([false, true])("retires automation access and late pages: loaded=%s", async (loaded) => {
  const pending = createDeferred<Page>();
  const current = component(sequence(loaded ? page([job()]) : pending.promise));
  if (loaded) {
    await current.ready();
    current.request.mockReturnValueOnce(pending.promise);
    current.cron();
  }
  flush();
  const authorized = current.gateway.snapshot;
  current.publish({
    ...authorized,
    hello: hello(["operator.sessions.read"]),
  });
  await current.empty();
  pending.resolve(page([job({ name: "Retired automation" })]));
  await pending.promise;
  flush();
  current.cron();
  expect(current.request).toHaveBeenCalledTimes(loaded ? 2 : 1);
  expect(current.element.textContent).toBe("");
  current.request.mockResolvedValueOnce(page([job({ name: "Current automation" })]));
  current.publish(authorized);
  await current.ready("Current automation");
  expect(current.element.textContent).not.toContain("Retired automation");
});

it("shares the mobile session inventory with consumers without starting another catalog", async () => {
  const checkedAt = Date.now() - 30_000;
  const result = () =>
    page([
      job({
        lastMeaningfulResult: {
          outcome: "blocked",
          summary: "Waiting for Windows CI",
          atMs: checkedAt,
        },
        lastRunStatus: "error",
        lastRunAtMs: checkedAt - 60_000,
        lastTriggerEvalAtMs: checkedAt,
      }),
    ]);
  const current = mobile(createGatewayRequestMock(async () => result()));
  const { container } = current;
  const ready = () =>
    waitForSolid(() => {
      expect(container.textContent).toContain("Check the task");
      expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
    });
  await ready();
  expect(container.querySelector("output")?.textContent).toBe("1");
  expect(container.textContent).toContain("Waiting for Windows CI");
  expect(container.textContent).toContain("Check failed");
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(checkedAt).toISOString(),
  );
  expect(current.request).toHaveBeenCalledTimes(1);
  current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
  await ready();
  expect(current.request).toHaveBeenCalledTimes(2);
  current.unmount();
});

it("shares pending reads, retained results, and failed refresh recovery between the mobile list and overview", async () => {
  const checkedAt = Date.now() - 30_000;
  const first = createDeferred<Page>();
  const refresh = createDeferred<Page>();
  const recovery = createDeferred<Page>();
  const current = mobile(sequence(first.promise, refresh.promise, recovery.promise), true);
  const view = current;
  await waitForSolid(() => {
    expect(view.container.textContent).toContain("Loading automations…");
    expect(current.request).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector('.chat-details-mobile-root [data-details-group="automations"]'),
    ).toBeNull();
  });
  first.resolve(
    page([
      job({
        lastMeaningfulResult: {
          outcome: "blocked",
          summary: "Waiting for mobile review",
          atMs: checkedAt - 60_000,
        },
        lastRunStatus: "error",
        lastRunAtMs: checkedAt,
      }),
    ]),
  );
  const rows = () => view.container.querySelectorAll<HTMLAnchorElement>("a");
  await waitForSolid(() => expect(rows()).toHaveLength(1));
  const overview = view.container.querySelector(
    '.chat-details-mobile-root [data-details-destination="automation"]',
  );
  expect(overview?.textContent).toContain("Waiting for mobile review");
  expect(overview?.textContent).toContain("Check failed");
  expect(overview?.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(checkedAt).toISOString(),
  );
  const retainedRows = [...rows()];
  retainedRows[0]!.focus();
  current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
  await waitForSolid(() =>
    expect(view.container.querySelectorAll('[aria-busy="true"]')).toHaveLength(1),
  );
  expect(current.request).toHaveBeenCalledTimes(2);
  retainedRows.forEach((row, index) => expect(rows()[index]).toBe(row));
  refresh.reject(new Error("private inventory failure"));
  await waitForSolid(() => {
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't update automations.",
    );
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
  });
  retainedRows.forEach((row, index) => expect(rows()[index]).toBe(row));
  expect(document.activeElement).toBe(retainedRows[0]);
  expect(view.container.textContent).not.toContain("private inventory failure");
  view.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() =>
    expect(view.container.querySelectorAll('[aria-busy="true"]')).toHaveLength(1),
  );
  expect(current.request).toHaveBeenCalledTimes(3);
  recovery.resolve(page([job({ name: "Recovered automation" })]));
  await waitForSolid(() => {
    expect(rows()[0]?.textContent).toContain("Recovered automation");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  retainedRows.forEach((row, index) => expect(rows()[index]).toBe(row));
  view.unmount();
});

it("expands 25 retained jobs in tens independently of RPC pagination and resets on reentry", async () => {
  const pending = createDeferred<Page>();
  const jobs = Array.from({ length: 25 }, (_, index) =>
    job({ id: `job-${index}`, name: `Automation ${index + 1}` }),
  );
  const current = component(
    createGatewayRequestMock()
      .mockResolvedValueOnce(page(jobs))
      .mockImplementationOnce(() => pending.promise),
  );
  const { element } = current;
  await current.ready("Automation 1");
  const rows = () => element.querySelectorAll<HTMLAnchorElement>(".chat-summary__automation");
  expect(rows()).toHaveLength(10);
  const more = element.querySelector<HTMLButtonElement>(".chat-summary__automation-more")!;
  more.focus();
  more.click();
  flush();
  expect(rows()).toHaveLength(20);
  expect(document.activeElement).toBe(rows()[10]);
  more.focus();
  more.click();
  flush();
  expect(rows()).toHaveLength(25);
  expect(document.activeElement).toBe(rows()[20]);
  expect(element.querySelector(".chat-summary__automation-more")).toBeNull();
  expect(current.request).toHaveBeenCalledTimes(1);
  current.update({ onNavigate: vi.fn() });
  expect(rows()).toHaveLength(25);
  current.update({ presented: false });
  current.update({ presented: true });
  expect(rows()).toHaveLength(10);
  expect(current.request).toHaveBeenCalledTimes(2);
  pending.reject(new Error("refresh failed"));
  await waitForSolid(() => {
    expect(element.textContent).not.toContain("Couldn't update automations.");
    expect(element.querySelector('[aria-busy="false"]')).not.toBeNull();
  });
  expect(rows()).toHaveLength(10);
  expect(element.querySelector("summary")?.textContent?.trim()).toBe("Automations");
});

it("retains reconnect facts and distinguishes auto-disabled from paused and stale running", async () => {
  const pending = createDeferred<Page>();
  const current = component(
    jobsRequest(
      job({
        id: "attention",
        name: "Needs attention",
        enabled: false,
        autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 3 },
      }),
      job({ id: "paused", name: "User paused", enabled: false }),
      job({ id: "running", name: "In progress", runningAtMs: 42 }),
    ).mockImplementationOnce(() => pending.promise),
  );
  const { element } = current;
  await current.ready("Needs attention");
  const attention = element.querySelector<HTMLAnchorElement>('[href$="job=attention"]')!;
  expect(attention.textContent).not.toContain("Paused");
  expect(attention.querySelector(".chat-summary__automation-attention")).not.toBeNull();
  expect(element.querySelectorAll(".chat-summary__automation-paused")).toHaveLength(1);
  expect(element.querySelectorAll(".session-run-spinner")).toHaveLength(1);
  const snapshot = current.gateway.snapshot;
  current.publish({ ...snapshot, phase: "reconnecting" });
  await waitForSolid(() => {
    expect(element.textContent).toContain("In progress");
    expect(element.textContent).not.toContain("Running");
  });
  current.publish(snapshot);
  flush();
  expect(element.querySelectorAll(".chat-summary__automation")).toHaveLength(3);
  pending.resolve(page());
  await current.empty();
});

it("describes cron weekdays and non-uniform minute steps without inventing a fixed interval", async () => {
  const current = component(
    jobsRequest(
      job({
        id: "weekdays",
        name: "Weekday review",
        scheduleKind: "cron",
        schedule: { kind: "cron", expr: "0 9 * * MON-FRI", tz: "UTC" },
      }),
      job({
        id: "minute-grid",
        name: "Minute grid",
        scheduleKind: "cron",
        schedule: { kind: "cron", expr: "*/7 * * * *", tz: "UTC" },
      }),
    ),
  );
  await current.ready("Weekday review");
  await vi.dynamicImportSettled();
  const weekday = current.element.querySelector<HTMLAnchorElement>('a[href$="job=weekdays"]')!;
  const minutes = current.element.querySelector<HTMLAnchorElement>('a[href$="job=minute-grid"]')!;
  // Inventory readiness does not include the first lazy cron formatter import.
  await waitForSolid(
    () => {
      expect(weekday.textContent).toContain("Weekdays at 9:00 AM");
      expect(minutes.textContent).toContain(
        "At minutes 0, 7, 14, 21, 28, 35, 42, 49, and 56 of every hour",
      );
    },
    { timeout: 5_000 },
  );
  expect(minutes.textContent).not.toContain("Every 7 minutes");
});
