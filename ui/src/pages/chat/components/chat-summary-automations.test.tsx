/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
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

const mounted: HTMLElement[] = [];
const observers: MutationObserver[] = [];
type Page = CronJobsListResult<CronCompactJob>;
function component(
  request = createGatewayRequestMock(async () => page()),
  presented = true,
  offline = false,
) {
  const source = createApplicationGateway({
    client: createTestGatewayClient(request),
    phase: offline ? "offline" : "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "ops",
    sessionKey: "agent:ops:task",
    lastError: null,
    lastErrorCode: null,
  });
  type Props = Parameters<typeof ChatSummaryAutomations>[0];
  let update!: (next: Partial<Props>) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal<Props>({
      gateway: source.gateway,
      sessionKey: "agent:ops:task",
      presented,
    });
    update = (next) => {
      setProps((current) => ({ ...current, ...next }));
      flush();
    };
    return <ChatSummaryAutomations {...props()} />;
  });
  const element = view.container.querySelector<HTMLElement>("openclaw-chat-summary-automations")!;
  return {
    ...source,
    request,
    ...view,
    element,
    find: <T extends HTMLElement = HTMLElement>(selector: string) =>
      element.querySelector<T>(selector),
    ready: (text = "Check the task") => textReady(element, text),
    empty: () =>
      observe(element, () => element.querySelector(".chat-summary__automations") === null),
    cron: (action = "updated") =>
      source.publishEvent({ type: "event", event: "cron", payload: { action } }),
    update,
  };
}

function retrying() {
  const pending = createDeferred<Page>();
  return {
    pending,
    ...component(
      createGatewayRequestMock()
        .mockRejectedValueOnce(new Error("private server detail"))
        .mockReturnValueOnce(pending.promise),
    ),
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
  it("keeps its initial inventory through unrelated Gateway snapshots", async () => {
    const pending = createDeferred<Page>();
    const current = component(
      createGatewayRequestMock()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(page([job()])),
    );
    flush();
    current.publish({ ...current.gateway.snapshot });
    expect(current.request).toHaveBeenCalledTimes(1);
    pending.resolve(page([job()]));
    await current.ready();
    current.publish({ ...current.gateway.snapshot });
    expect(current.request).toHaveBeenCalledTimes(1);
    current.update({ presented: false });
    current.update({ presented: true });
    await current.ready();
    expect(current.request).toHaveBeenCalledTimes(2);
    current.cron();
    await current.ready();
    expect(current.request).toHaveBeenCalledTimes(3);
  });

  it("admits only presented session-scoped reads and uses the existing automation destination", async () => {
    const pending = createDeferred<Page>();
    const current = component(
      createGatewayRequestMock(() => pending.promise),
      false,
    );
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
    expect(link.querySelector(".chat-summary__automation-title")?.textContent?.trim()).toBe(
      fullTitle,
    );
    expect(find<HTMLDetailsElement>('[data-details-group="automations"]')?.open).toBe(true);
    expect(link.querySelector("svg")).not.toBeNull();
    const onNavigate = vi.fn();
    current.update({ onNavigate });
    link.click();
    expect(onNavigate).toHaveBeenCalledWith("summary-job");
    expect(current.request).toHaveBeenCalledTimes(1);
  });

  it("omits confirmed-empty sections and preserves manual collapse until the content disappears", async () => {
    const current = component(
      createGatewayRequestMock()
        .mockResolvedValueOnce(page())
        .mockResolvedValue(page([job()])),
    );
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

  it("keeps Retry focused while pending, preserves sibling disclosure, and moves focus only after its own success", async () => {
    const current = retrying();
    const { element, find, pending } = current;
    const sibling = document.createElement("details");
    sibling.open = false;
    mounted.push(sibling);
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
    pending.resolve(page([job()]));
    await current.ready();
    flush();
    expect(document.activeElement).toBe(find(".chat-summary__automation"));
    expect(sibling.open).toBe(false);
  });

  it("does not steal composer focus when a retry resolves after the user moves away", async () => {
    const current = retrying();
    await current.ready("Couldn't load automations.");
    current.find<HTMLButtonElement>(".chat-summary__automation-retry")!.click();
    const composer = document.createElement("textarea");
    composer.value = "Keep my draft";
    mounted.push(composer);
    document.body.append(composer);
    composer.focus();
    current.pending.resolve(page());
    await current.empty();
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("Keep my draft");
  });

  it("fences late pages on session and same-client reconnect boundaries", async () => {
    const retired = createDeferred<Page>();
    const reconnectRetired = createDeferred<Page>();
    const latest = createDeferred<Page>();
    const current = component(
      createGatewayRequestMock()
        .mockReturnValueOnce(retired.promise)
        .mockReturnValueOnce(reconnectRetired.promise)
        .mockReturnValueOnce(latest.promise),
    );
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

  it("coalesces hidden cron publications until presentation and removes subscriptions on unmount", async () => {
    const current = component(createGatewayRequestMock(async () => page([job()])));
    await current.ready();
    current.update({ presented: false });
    current.cron();
    current.cron();
    flush();
    expect(current.request).toHaveBeenCalledTimes(1);
    current.update({ presented: true });
    await current.ready();
    expect(current.request).toHaveBeenCalledTimes(2);
    current.unmount();
    current.cron();
    current.publish(current.gateway.snapshot);
    flush();
    expect(current.request).toHaveBeenCalledTimes(2);
  });

  it("retains same-scope automation facts offline and clears them on session replacement", async () => {
    const current = component(createGatewayRequestMock(async () => page([job()])));
    const { element } = current;
    await current.ready();
    current.publish({ ...current.gateway.snapshot, phase: "offline", client: null });
    flush();
    expect(element.textContent).toContain("Check the task");
    expect(element.textContent).not.toContain("Reconnect to load");
    current.update({ sessionKey: "agent:ops:other" });
    expect(element.textContent).not.toContain("Check the task");
  });

  it("does not invent empty inventory offline or for an unresolved session owner", async () => {
    const current = component(undefined, true, true);
    const { element } = current;
    flush();
    expect(element.textContent).toContain("Offline · last-known automations");
    expect(element.textContent).not.toContain("No automations");
    expect(current.request).not.toHaveBeenCalled();
    current.update({ sessionKey: "unresolved-session" });
    current.publish({ ...current.gateway.snapshot, phase: "connected" });
    flush();
    expect(element.textContent).toContain("Automations unavailable for this session.");
    expect(current.request).not.toHaveBeenCalled();
  });

  it("uses the inventory continuation rather than silently dropping additional automations", async () => {
    const current = component(
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
});
