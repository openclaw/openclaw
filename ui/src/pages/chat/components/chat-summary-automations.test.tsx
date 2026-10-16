/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

function job(overrides: Partial<CronCompactJob> = {}): CronCompactJob {
  return {
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
  };
}

function page(
  jobs: CronCompactJob[] = [],
  overrides: Partial<CronJobsListResult<CronCompactJob>> = {},
): CronJobsListResult<CronCompactJob> {
  return {
    jobs,
    snapshotRevision: "fixture-1",
    offset: 0,
    limit: 50,
    total: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}

function source(request = createGatewayRequestMock(async () => page())) {
  return {
    request,
    ...createApplicationGateway({
      client: createTestGatewayClient(request),
      phase: "connected",
      offlineStable: false,
      hello: null,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "ops",
      sessionKey: "agent:ops:task",
      lastError: null,
      lastErrorCode: null,
    }),
  };
}

const mounted: HTMLElement[] = [];
const observers: MutationObserver[] = [];
function component(gateway: ApplicationGateway, presented = true) {
  type Props = Parameters<typeof ChatSummaryAutomations>[0];
  let update!: (next: Partial<Props>) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal<Props>({
      gateway,
      sessionKey: "agent:ops:task",
      presented,
    });
    update = (next) => setProps((current) => ({ ...current, ...next }));
    return <ChatSummaryAutomations {...props()} />;
  });
  return {
    ...view,
    element: view.container.querySelector<HTMLElement>("openclaw-chat-summary-automations")!,
    update,
  };
}

// The rendered request state is the completion signal; no timer or polling loop.
function observe(element: HTMLElement, ready: () => boolean): Promise<void> {
  if (ready()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (ready()) {
        observer.disconnect();
        resolve();
      }
    });
    observers.push(observer);
    observer.observe(element, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

function textReady(element: HTMLElement, text: string) {
  return observe(
    element,
    () =>
      element.textContent?.includes(text) && element.querySelector('[aria-busy="false"]') !== null,
  );
}

afterEach(() => {
  for (const observer of observers.splice(0)) {
    observer.disconnect();
  }
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("Details compact automations", () => {
  it("admits only presented session-scoped reads and uses the existing automation destination", async () => {
    const pending = createDeferred<CronJobsListResult<CronCompactJob>>();
    const current = source(createGatewayRequestMock(() => pending.promise));
    const view = component(current.gateway, false);
    const { element } = view;
    flush();
    expect(current.request).not.toHaveBeenCalled();
    view.update({ presented: true });
    flush();
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
    await textReady(element, fullTitle);
    const link = element.querySelector<HTMLAnchorElement>(".chat-summary__automation")!;
    expect(link.getAttribute("href")).toBe("/automations?job=summary-job");
    expect(link.textContent).toContain("Every 10m");
    expect(link.querySelector(".chat-summary__automation-title")?.textContent?.trim()).toBe(
      fullTitle,
    );
    expect(
      element.querySelector<HTMLDetailsElement>('[data-details-group="automations"]')?.open,
    ).toBe(true);
    expect(link.querySelector("svg")).not.toBeNull();
    const onNavigate = vi.fn();
    view.update({ onNavigate });
    flush();
    link.click();
    expect(onNavigate).toHaveBeenCalledWith("summary-job");
    expect(current.request).toHaveBeenCalledTimes(1);
  });

  it("omits confirmed-empty sections and preserves manual collapse until the content disappears", async () => {
    const current = source(
      createGatewayRequestMock()
        .mockResolvedValueOnce(page())
        .mockResolvedValue(page([job()])),
    );
    const view = component(current.gateway);
    const { element } = view;
    flush();
    await observe(element, () => element.querySelector(".chat-summary__automations") === null);
    expect(element.querySelector("summary")).toBeNull();
    current.publishEvent({ type: "event", event: "cron", payload: { action: "added" } });
    await textReady(element, "Check the task");
    const group = element.querySelector<HTMLDetailsElement>("details")!;
    expect(group.open).toBe(true);
    group.open = false;
    group.dispatchEvent(new Event("toggle"));
    flush();
    current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
    flush();
    await textReady(element, "Check the task");
    expect(element.querySelector("details")).toBe(group);
    expect(group.open).toBe(false);
    current.request.mockResolvedValueOnce(page());
    current.publishEvent({ type: "event", event: "cron", payload: { action: "removed" } });
    await observe(element, () => element.querySelector(".chat-summary__automations") === null);
    expect(element.querySelector("summary")).toBeNull();
    current.publishEvent({ type: "event", event: "cron", payload: { action: "added" } });
    await textReady(element, "Check the task");
    expect(element.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
  });

  it("keeps Retry focused while pending, preserves sibling disclosure, and moves focus only after its own success", async () => {
    const pending = createDeferred<CronJobsListResult<CronCompactJob>>();
    const current = source(
      createGatewayRequestMock()
        .mockRejectedValueOnce(new Error("private server detail"))
        .mockImplementationOnce(() => pending.promise),
    );
    const view = component(current.gateway);
    const { element } = view;
    const sibling = document.createElement("details");
    sibling.open = false;
    mounted.push(sibling);
    document.body.append(sibling);
    await textReady(element, "Couldn't load automations.");
    expect(element.textContent).not.toContain("private server detail");
    const retry = element.querySelector<HTMLButtonElement>(".chat-summary__automation-retry")!;
    expect(retry.textContent?.trim()).toBe("Retry");
    retry.focus();
    retry.click();
    flush();
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    retry.click();
    expect(current.request).toHaveBeenCalledTimes(2);
    pending.resolve(page([job()]));
    await textReady(element, "Check the task");
    flush();
    expect(document.activeElement).toBe(element.querySelector(".chat-summary__automation"));
    expect(sibling.open).toBe(false);
  });

  it("does not steal composer focus when a retry resolves after the user moves away", async () => {
    const pending = createDeferred<CronJobsListResult<CronCompactJob>>();
    const current = source(
      createGatewayRequestMock()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementationOnce(() => pending.promise),
    );
    const view = component(current.gateway);
    const { element } = view;
    await textReady(element, "Couldn't load automations.");
    element.querySelector<HTMLButtonElement>(".chat-summary__automation-retry")!.click();
    const composer = document.createElement("textarea");
    composer.value = "Keep my draft";
    mounted.push(composer);
    document.body.append(composer);
    composer.focus();
    pending.resolve(page());
    await observe(element, () => element.querySelector(".chat-summary__automations") === null);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("Keep my draft");
  });

  it("fences late pages on session and same-client reconnect boundaries", async () => {
    const retired = createDeferred<CronJobsListResult<CronCompactJob>>();
    const reconnectRetired = createDeferred<CronJobsListResult<CronCompactJob>>();
    const latest = createDeferred<CronJobsListResult<CronCompactJob>>();
    const current = source(
      createGatewayRequestMock()
        .mockImplementationOnce(() => retired.promise)
        .mockImplementationOnce(() => reconnectRetired.promise)
        .mockImplementationOnce(() => latest.promise),
    );
    const view = component(current.gateway);
    const { element } = view;
    flush();
    view.update({ sessionKey: "agent:ops:second" });
    flush();
    const snapshot = current.gateway.snapshot;
    current.publish({ ...snapshot, phase: "reconnecting" });
    current.publish(snapshot);
    flush();
    expect(current.request).toHaveBeenCalledTimes(3);
    expect(current.request.mock.calls[2]?.[1]).toMatchObject({ sessionKey: "agent:ops:second" });
    latest.resolve(page([job({ name: "Current session" })]));
    await textReady(element, "Current session");
    retired.resolve(page([job({ name: "Wrong session" })]));
    reconnectRetired.resolve(page([job({ name: "Retired connection" })]));
    await retired.promise;
    await reconnectRetired.promise;
    flush();
    expect(element.textContent).toContain("Current session");
    expect(element.textContent).not.toMatch(/Wrong session|Retired connection/);
  });

  it("coalesces hidden cron publications until presentation and removes subscriptions on unmount", async () => {
    const current = source(createGatewayRequestMock(async () => page([job()])));
    const view = component(current.gateway);
    const { element } = view;
    await textReady(element, "Check the task");
    view.update({ presented: false });
    flush();
    current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
    current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
    flush();
    expect(current.request).toHaveBeenCalledTimes(1);
    view.update({ presented: true });
    flush();
    await textReady(element, "Check the task");
    expect(current.request).toHaveBeenCalledTimes(2);
    view.unmount();
    current.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
    current.publish(current.gateway.snapshot);
    flush();
    expect(current.request).toHaveBeenCalledTimes(2);
  });

  it("retains same-scope automation facts offline and clears them on session replacement", async () => {
    const current = source(createGatewayRequestMock(async () => page([job()])));
    const view = component(current.gateway);
    const { element } = view;
    await textReady(element, "Check the task");
    current.publish({ ...current.gateway.snapshot, phase: "offline", client: null });
    flush();
    expect(element.textContent).toContain("Check the task");
    expect(element.textContent).not.toContain("Reconnect to load");
    view.update({ sessionKey: "agent:ops:other" });
    flush();
    expect(element.textContent).not.toContain("Check the task");
  });

  it("does not invent empty inventory offline or for an unresolved session owner", async () => {
    const current = source();
    current.publish({ ...current.gateway.snapshot, phase: "offline" });
    const view = component(current.gateway);
    const { element } = view;
    flush();
    expect(element.textContent).toContain("Offline · last-known automations");
    expect(element.textContent).not.toContain("No automations");
    expect(current.request).not.toHaveBeenCalled();
    view.update({ sessionKey: "unresolved-session" });
    flush();
    current.publish({ ...current.gateway.snapshot, phase: "connected" });
    flush();
    expect(element.textContent).toContain("Automations unavailable for this session.");
    expect(current.request).not.toHaveBeenCalled();
  });

  it("uses the inventory continuation rather than silently dropping additional automations", async () => {
    const current = source(
      createGatewayRequestMock()
        .mockResolvedValueOnce(
          page([job({ name: "First automation", enabled: false })], {
            total: 2,
            hasMore: true,
            nextOffset: 1,
          }),
        )
        .mockResolvedValueOnce(
          page([job({ id: "second", name: "Second automation", runningAtMs: 42 })], {
            offset: 1,
            total: 2,
          }),
        ),
    );
    const view = component(current.gateway);
    const { element } = view;
    await textReady(element, "First automation");
    expect(element.textContent).toContain("Paused");
    element.querySelector<HTMLButtonElement>(".chat-summary__automation-more")!.click();
    await textReady(element, "Second automation");
    expect(current.request.mock.calls[1]?.[1]).toMatchObject({
      offset: 1,
      sessionKey: "agent:ops:task",
      sessionAgentId: "ops",
    });
    expect(element.querySelectorAll(".chat-summary__automation")).toHaveLength(2);
    expect(element.textContent).toContain("Running");
    expect(element.querySelector(".chat-summary__automation-more")).toBeNull();
  });
});
