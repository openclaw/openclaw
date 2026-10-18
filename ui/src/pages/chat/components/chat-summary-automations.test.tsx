/* @vitest-environment jsdom */
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
function component(
  request = sequence(page([job()])),
  presented = true,
  offline = false,
  scopes = ["operator.read"],
) {
  const source = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: offline ? "offline" : "connected",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes } },
    assistantAgentId: "ops",
    sessionKey: "agent:ops:task",
  });
  type Props = Parameters<typeof ChatSummaryAutomations>[0];
  const [props, setProps] = createSignal<Props>({
    gateway: source.gateway,
    sessionKey: "agent:ops:task",
    presented,
  });
  const view = mountSolid(() => <ChatSummaryAutomations {...props()} />);
  const element = view.container.querySelector<HTMLElement>("openclaw-chat-summary-automations")!;
  return {
    ...source,
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
    cron: (action = "updated") =>
      source.publishEvent({ type: "event", event: "cron", payload: { action } }),
    update: (next: Partial<Props>) => {
      setProps((current) => ({ ...current, ...next }));
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

it("admits only presented session-scoped reads and uses the existing automation destination", async () => {
  const pending = createDeferred<Page>();
  const current = component(sequence(pending.promise), false);
  const { element, find } = current;
  flush();
  expect(current.request).not.toHaveBeenCalled();
  current.update({ presented: true });
  expect(element.textContent).toContain("Loading automations…");
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
  expect(link.textContent).toContain("Every 10m");
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
  current.request.mockResolvedValueOnce(page());
  current.cron("removed");
  await current.empty();
  expect(find("summary")).toBeNull();
  current.cron("added");
  await current.ready();
  expect(find<HTMLDetailsElement>("details")?.open).toBe(true);
});

it.each([false, true])("restores retry focus: moved=%s", async (moved) => {
  const pending = createDeferred<Page>();
  const current = component(
    createGatewayRequestMock()
      .mockRejectedValueOnce(new Error("private server detail"))
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
  expect(element.textContent).toContain(
    loaded ? "Check the task" : "Offline · last-known automations",
  );
  expect(element.textContent).not.toContain("No automations");
  if (loaded) {
    expect(element.textContent).not.toContain("Reconnect to load");
  }
  current.update({ sessionKey: loaded ? "agent:ops:other" : "unresolved-session" });
  expect(element.textContent).not.toContain("Check the task");
  if (!loaded) {
    current.publish({ ...current.gateway.snapshot, phase: "connected" });
    flush();
    expect(element.textContent).toContain("Automations unavailable for this session.");
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
    hello: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.sessions.read"] },
    },
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
