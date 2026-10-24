/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatDetailsMobileHostContent } from "../chat-details-mobile-host-content.tsx";
import { createChatMobileHostFixture } from "../chat-mobile-host.test-support.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

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
function source(request = sequence(page([job()])), offline = false, scopes = ["operator.read"]) {
  const current = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: offline ? "offline" : "connected",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes } },
    assistantAgentId: "ops",
    sessionKey: "agent:ops:task",
  });
  return {
    request,
    ...current,
    phase: (phase: typeof current.gateway.snapshot.phase) =>
      current.publish({ ...current.gateway.snapshot, phase }),
    scopes: (nextScopes: string[]) =>
      current.publish({
        ...current.gateway.snapshot,
        hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: nextScopes } },
      }),
  };
}
function component(
  request = sequence(page([job()])),
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
    part: <T extends Element = HTMLElement>(suffix = "") =>
      element.querySelector<T>(`.chat-summary__automation${suffix}`),
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

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

it.each([false, true])(
  "coalesces inventory events while hidden or reading (hidden=%s)",
  async (hidden) => {
    const pending = createDeferred<Page>();
    const ui = component(
      sequence(page([job()]), pending.promise, page([job({ name: "Current" })])),
    );
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await ui.ready();
    ui.publish({ ...ui.gateway.snapshot });
    expect(ui.request).toHaveBeenCalledTimes(1);
    ui.cron();
    ui.cron();
    ui.cron();
    expect(ui.request).toHaveBeenCalledTimes(2);
    if (hidden) {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    pending.resolve(page([job({ name: "Older" })]));
    if (hidden) {
      await ui.ready("Older");
      expect(ui.request).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await ui.ready("Current");
    expect(ui.request).toHaveBeenCalledTimes(3);
    ui.update({ presented: false });
    ui.cron();
    ui.cron();
    expect(ui.request).toHaveBeenCalledTimes(3);
    ui.request.mockResolvedValue(page([job()]));
    ui.update({ presented: true });
    await ui.ready();
    expect(ui.request).toHaveBeenCalledTimes(4);
    ui.unmount();
    ui.cron();
    ui.publish(ui.gateway.snapshot);
    flush();
    expect(ui.request).toHaveBeenCalledTimes(4);
  },
);

it("updates a held automation's runtime state without rereading its inventory", async () => {
  const current = component(sequence(page([job()])).mockResolvedValue(page([job()])));
  await current.ready();
  const eventJob = { id: "summary-job", name: "Check the task", agentId: "ops", enabled: true };
  current.cron("started", {
    jobId: "summary-job",
    job: { ...eventJob, updatedAtMs: 2, state: { runningAtMs: 2 } },
  });
  await current.ready("Running");
  expect(current.request).toHaveBeenCalledTimes(1);

  current.cron("finished", {
    jobId: "summary-job",
    job: {
      ...eventJob,
      updatedAtMs: 3,
      state: { lastRunAtMs: 3, lastRunStatus: "ok", nextRunAtMs: 600_003 },
    },
  });
  await current.ready("Every 10 minutes");
  expect(current.element.textContent).not.toContain("Running");
  expect(current.request).toHaveBeenCalledTimes(1);
  current.unmount();
});

it("omits confirmed-empty sections and preserves manual collapse until the content disappears", async () => {
  const title = "A long automation title that must remain unabridged and accessible";
  const current = component(
    sequence(page()).mockResolvedValue(page([job({ name: title })])),
    false,
  );
  flush();
  expect(current.request).not.toHaveBeenCalled();
  current.update({ presented: true });
  expect(current.element.textContent?.trim()).toBe("");
  await current.empty();
  expect(current.find("summary")).toBeNull();
  current.cron("added");
  await current.ready(title);
  expect(current.part("-title")?.textContent?.trim()).toBe(title);
  const onNavigate = vi.fn();
  current.update({ onNavigate });
  current.part<HTMLAnchorElement>()!.click();
  expect(onNavigate).toHaveBeenCalledWith("summary-job");
  const group = current.find<HTMLDetailsElement>("details")!;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new Event("toggle"));
  flush();
  current.cron();
  flush();
  await current.ready(title);
  expect(current.find("details")).toBe(group);
  expect(group.open).toBe(false);
  const link = current.part("");
  current.update({ presented: false });
  current.update({ presented: true });
  await current.ready(title);
  expect(current.find("details")).toBe(group);
  expect(group.open).toBe(false);
  expect(current.part("")).toBe(link);
  current.request.mockResolvedValueOnce(page());
  current.cron("removed");
  await current.empty();
  expect(current.find("summary")).toBeNull();
  current.cron("added");
  await current.ready(title);
  expect(current.find<HTMLDetailsElement>("details")?.open).toBe(true);
});

it.each(["recover", "hidden", "offline", "denied", "unmounted"] as const)(
  "settles scheduled inventory recovery: %s",
  async (boundary) => {
    vi.useFakeTimers();
    const current = component(
      createGatewayRequestMock().mockRejectedValue(new Error("Temporary failure")),
    );
    await tick();
    expect(current.part("-retry")).toBeNull();
    const count = current.request.mock.calls.length;
    if (boundary === "recover") {
      current.request.mockResolvedValue(
        page([job({ name: "Recovered automation", enabled: false })]),
      );
      current.publish({ ...current.gateway.snapshot });
      await tick(29_999);
      expect(current.request).toHaveBeenCalledTimes(count);
      await tick(1);
      expect(current.element.textContent).toContain("Recovered automation");
      expect(current.element.textContent).toContain("Paused");
      expect(current.part("-retry")).toBeNull();
      expect(current.request).toHaveBeenCalledTimes(count + 1);
      return;
    }
    if (boundary === "hidden") {
      current.update({ presented: false });
    } else if (boundary === "offline") {
      current.phase("reconnecting");
    } else if (boundary === "denied") {
      current.scopes([]);
    } else {
      current.unmount();
    }
    await tick(60_000);
    expect(current.request).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
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
    await tick();
    expect(current.element.textContent).toContain("Check the task");
    request.mockRejectedValue(
      new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Read authority revoked" }),
    );
    current.cron();
    await tick();
    expect(current.element.textContent).not.toContain("Check the task");
    expect(current.part("-more")).toBeNull();
    current.publish({ ...current.gateway.snapshot });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    request.mockResolvedValue(page([job({ name: "Authorized automation", enabled: false })]));
    if (recovery === "retry") {
      current.part<HTMLButtonElement>("-retry")!.click();
    } else if (recovery === "event") {
      current.cron();
    } else {
      const snapshot = current.gateway.snapshot;
      current.publish({ ...snapshot, phase: "reconnecting" });
      current.publish(snapshot);
    }
    await tick();
    expect(current.element.textContent).toContain("Authorized automation");
    expect(current.element.textContent).toContain("Paused");
    expect(request).toHaveBeenCalledTimes(3);
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
  const { element } = current;
  await current.ready("Couldn't load automations.");
  expect(element.textContent).not.toContain("private server detail");
  const retry = current.part<HTMLButtonElement>("-retry")!;
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
  expect(document.activeElement).toBe(moved ? composer : current.part(""));
  expect(composer.value).toBe("Keep my draft");
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
  current.phase("reconnecting");
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

it("does not invent inventory while offline or without a resolvable session", async () => {
  const ui = component(undefined, true, true);
  flush();
  expect(ui.element.textContent?.trim()).toBe("");
  ui.update({ sessionKey: "unresolved-session" });
  ui.phase("connected");
  flush();
  expect(ui.element.textContent?.trim()).toBe("");
  expect(ui.request).not.toHaveBeenCalled();
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
  current.scopes(["operator.sessions.read"]);
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

it("shares pending reads and failed refresh recovery between the mobile list and overview", async () => {
  const first = createDeferred<Page>();
  const refresh = createDeferred<Page>();
  const recovery = createDeferred<Page>();
  const current = source(sequence(first.promise, refresh.promise, recovery.promise));
  const context = { ...createInitializationContext(), gateway: current.gateway };
  const host = createChatMobileHostFixture("automations", {
    open: true,
    destination: { area: "details" },
  });
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ChatDetailsMobileHostContent
        host={host}
        details={{ sessionKey: "agent:ops:task", currentAgentId: "ops", messages: [] }}
        presented
      />
    </ApplicationProvider>
  ));
  await waitForSolid(() => {
    expect(view.container.textContent).toContain("Loading automations…");
    expect(current.request).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector('.chat-details-mobile-root [data-details-group="automations"]'),
    ).toBeNull();
  });
  first.resolve(page([job()]));
  const rows = () => view.container.querySelectorAll<HTMLAnchorElement>("a");
  await waitForSolid(() => {
    expect(rows()).toHaveLength(1);
    expect(
      view.container.querySelector('[data-details-group="automations"] button')?.textContent,
    ).toContain("Check the task");
  });
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

it.each([false, true])(
  "reveals retained and paged jobs, then resets on reentry (paged=%s)",
  async (paged) => {
    const pending = createDeferred<Page>();
    const jobs = Array.from({ length: 25 }, (_, index) =>
      job({ id: `job-${index}`, name: `Automation ${index + 1}` }),
    );
    const request = sequence(
      page(paged ? jobs.slice(0, 10) : jobs, {
        total: 25,
        hasMore: paged,
        nextOffset: paged ? 10 : null,
      }),
    );
    if (paged) {
      request.mockResolvedValueOnce(page(jobs.slice(10), { offset: 10, total: 25 }));
    }
    request.mockReturnValueOnce(pending.promise);
    const ui = component(request);
    await ui.ready("Automation 1");
    const rows = () => ui.element.querySelectorAll<HTMLAnchorElement>(".chat-summary__automation");
    expect(rows()).toHaveLength(10);
    for (const [count, focused] of [
      [20, 10],
      [25, 20],
    ] as const) {
      const more = ui.part<HTMLButtonElement>("-more")!;
      more.focus();
      more.click();
      await ui.ready("Automation 1");
      expect(rows()).toHaveLength(count);
      expect(document.activeElement).toBe(rows()[focused]);
    }
    expect(ui.part("-more")).toBeNull();
    expect(request).toHaveBeenCalledTimes(paged ? 2 : 1);
    ui.update({ presented: false });
    ui.update({ presented: true });
    expect(rows()).toHaveLength(10);
    pending.reject(new Error("refresh failed"));
    await ui.ready("Automation 1");
    expect(ui.element.textContent).not.toContain("Couldn't update automations.");
    expect(rows()).toHaveLength(10);
  },
);

it("retains reconnect facts and distinguishes auto-disabled from paused and stale running", async () => {
  const pending = createDeferred<Page>();
  const current = component(
    createGatewayRequestMock()
      .mockResolvedValueOnce(
        page([
          job({
            id: "attention",
            name: "Needs attention",
            enabled: false,
            autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 3 },
          }),
          job({ id: "paused", name: "User paused", enabled: false }),
          job({ id: "running", name: "In progress", runningAtMs: 42 }),
        ]),
      )
      .mockImplementationOnce(() => pending.promise),
  );
  const { element } = current;
  await current.ready("Needs attention");
  const attention = element.querySelector<HTMLAnchorElement>('[href$="job=attention"]')!;
  expect(attention.textContent).not.toContain("Paused");
  expect(attention.querySelector(".chat-summary__automation-attention")).not.toBeNull();
  expect(element.querySelectorAll(".chat-summary__automation-paused")).toHaveLength(1);
  expect(element.querySelectorAll(".session-run-spinner")).toHaveLength(1);
  const snapshot = current.gateway.snapshot;
  current.publish({ ...snapshot, phase: "offline", client: null });
  await waitForSolid(() => {
    expect(element.textContent).toContain("In progress");
    expect(element.textContent).not.toContain("Running");
  });
  current.publish(snapshot);
  flush();
  expect(element.querySelectorAll(".chat-summary__automation")).toHaveLength(3);
  current.publish({ ...snapshot, phase: "offline", client: null });
  expect(element.querySelectorAll(".chat-summary__automation")).toHaveLength(3);
  current.update({ sessionKey: "agent:ops:other" });
  await current.empty();
  pending.resolve(page([job({ name: "Retired session" })]));
  await pending.promise;
  flush();
  expect(element.textContent).not.toContain("Retired session");
});

it.each([
  ["0 9 * * MON-FRI", "Weekdays at 9:00 AM"],
  ["*/7 * * * *", "At minutes 0, 7, 14, 21, 28, 35, 42, 49, and 56 of every hour"],
])("describes cron schedule %s without guessing an interval", async (expr, expected) => {
  const ui = component(
    sequence(page([job({ scheduleKind: "cron", schedule: { kind: "cron", expr, tz: "UTC" } })])),
  );
  await ui.ready();
  expect(ui.part()?.textContent).toContain(expected);
  expect(ui.part()?.textContent).not.toContain("Every 7 minutes");
});
