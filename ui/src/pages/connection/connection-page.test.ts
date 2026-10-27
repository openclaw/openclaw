/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { deviceSystemInfo } from "../../test-helpers/devices-fixtures.ts";
import { missingReadScopeErrorFixture } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import "../debug/debug-overlay-content.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { mockDocumentVisibility as mockVisibility } from "../../test-helpers/mock-cleanup.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { stubResizeObserver } from "../../test-helpers/resize-observer.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DebugOverlayElement } from "../debug/debug-overlay-state.ts";
import { ConnectionPage } from "./connection-page.tsx";
import "../debug/debug-overlay.ts";
const contains = (value: string) => expect.stringContaining(value);
const excludes = (value: string) => expect.not.stringContaining(value);

// Keep exact polling deadlines while waiting for Solid to commit async results.
function waitForPage(assertion: () => void) {
  return waitForSolid(assertion, { interval: 0 });
}

const gatewayActivity = {
  eventLoop: {
    utilization: 0.42,
    cpuCoreRatio: 0.24,
    delayP99Ms: 12,
    delayMaxMs: 87,
    degraded: false,
    reasons: [],
    intervalMs: 1_000,
  },
  processMemory: {
    rssBytes: 432 * 1_048_576,
    heapUsedBytes: 210 * 1_048_576,
    heapTotalBytes: 256 * 1_048_576,
  },
} satisfies Pick<SystemInfoResult, "eventLoop" | "processMemory">;
const gatewaySystemInfo = { ...deviceSystemInfo, ...gatewayActivity } satisfies SystemInfoResult;

function publish(current: ReturnType<typeof source>, patch: Partial<ApplicationGatewaySnapshot>) {
  current.publish({ ...current.gateway.snapshot, ...patch });
}

function makeClient(
  request: GatewayBrowserClient["request"] = vi.fn().mockResolvedValue(deviceSystemInfo),
) {
  return { request } as unknown as GatewayBrowserClient;
}

function mockClock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return (elapsed: number) => {
    now += elapsed;
  };
}

function text(page: HTMLElement, selector: string) {
  return page.querySelector(selector)?.textContent;
}

function findButton(root: ParentNode, label: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

function input(page: HTMLElement, label: string) {
  const element = control(page, `input[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected Connection input: ${label}`);
  }
  return element;
}

function source(
  client: GatewayBrowserClient = makeClient(),
  pingRequest: (
    ...args: Parameters<GatewayBrowserClient["request"]>
  ) => Promise<unknown> = async () => null,
) {
  const request = client.request.bind(client);
  client.request = ((method, ...args) =>
    method === "last-heartbeat"
      ? pingRequest(method, ...args)
      : request(method, ...args)) as GatewayBrowserClient["request"];
  return createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["system.info"]),
    sessionKey: "main",
  } as ApplicationGatewaySnapshot);
}

async function mount(
  gateway: ApplicationGateway,
  { attached = true, request }: { attached?: boolean; request?: ReturnType<typeof vi.fn> } = {},
) {
  const context = {
    gateway,
    channels: { state: { channelsLastSuccess: null }, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  if (attached) {
    document.body.append(provider);
  }
  const application = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => createComponent(ConnectionPage, {}), {
    container: provider,
    wrapper: application.wrapper,
  });
  const unmount = () => {
    view.unmount();
    provider.remove();
  };
  await waitForPage(() =>
    expect(provider.querySelector("openclaw-connection-page")).not.toBeNull(),
  );
  const state = () => ({ ...pageState(provider), calls: request?.mock.calls.length });
  const check = (expected: Partial<ReturnType<typeof state>>) =>
    waitForPage(() => expect(state()).toMatchObject(expected));
  const tick = async (ms: number, expected: Partial<ReturnType<typeof state>>) => {
    await vi.advanceTimersByTimeAsync(ms);
    await check(expected);
  };
  return {
    state,
    check,
    tick,
    page: provider,
    context,
    provider,
    unmount,
    setContext(this: void, value: ApplicationContext) {
      provider.setContext(value);
      application.setContext(value);
    },
  };
}

function pageState(page: HTMLElement) {
  const host = page.querySelector("#settings-connection-host");
  const metric = (label: string) =>
    [...page.querySelectorAll(".connection-ping__stats dt")]
      .find((term) => term.textContent?.trim() === label)
      ?.nextElementSibling?.textContent?.replace(/\s+/g, " ")
      .trim();
  return {
    hostName: text(page, ".config-host__name")?.trim() ?? null,
    busy: host?.getAttribute("aria-busy"),
    placeholders: host?.querySelectorAll('.skeleton[aria-hidden="true"]').length,
    activity: text(page, ".connection-activity"),
    activityFailed: text(page, ".connection-activity")?.includes("Activity refresh failed."),
    cpuDegraded: page.querySelector(".gateway-vital--cpu")?.hasAttribute("data-degraded"),
    hostSkeleton: page.querySelector(".config-host__name .skeleton"),
    hostElement: page.querySelector(".config-host__name"),
    ping: text(page, ".connection-ping"),
    average: metric("Avg ping"),
    p50: metric("p50"),
    p95: metric("p95"),
    p99: metric("p99"),
    secret: input(page, "Gateway secret").value,
    secretType: input(page, "Gateway secret").type,
    session: input(page, "Default session").value,
  };
}

async function setup(
  request = vi.fn().mockResolvedValue(deviceSystemInfo),
  ping?: Parameters<typeof source>[1],
) {
  const client = makeClient(request);
  const current = source(client, ping);
  return { ...(await mount(current.gateway, { request })), ...current, request, client };
}

async function display(snapshot: Partial<ApplicationGatewaySnapshot> = {}) {
  const current = source();
  publish(current, snapshot);
  return { ...(await mount(current.gateway)), ...current };
}

function authHello(authMode: "token" | "password" | "trusted-proxy"): GatewayHelloOk {
  return { ...gatewayHelloForMethods(["system.info"]), snapshot: { authMode } };
}

function control(page: HTMLElement, selector: string) {
  const element = page.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
  if (!element) {
    throw new Error(`Missing Connection control: ${selector}`);
  }
  return element;
}

afterEach(async () => {
  cleanupSolid();
  document.body.replaceChildren();
  await Promise.resolve();
  flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.documentElement.dataset.openclawRemoteIngress;
});

it.each([
  { phase: "stopped", stale: false },
  { phase: "reconnecting", stale: false },
  { phase: "connected", stale: false },
  { phase: "offline", stale: true },
] as const)(
  "requires a current confirmation while $phase (stale=$stale)",
  async ({ phase, stale }) => {
    const { gateway } = createApplicationGateway({
      phase,
      sessionKey: "main",
    } as ApplicationGatewaySnapshot);
    let stored = true;
    gateway.hasStoredDeviceToken = () => stored;
    gateway.forgetDeviceToken = vi.fn(() => {
      stored = false;
      return true;
    });
    const { page } = await mount(gateway);
    const forget = () => findButton(page, "Forget this browser");
    const confirm = () =>
      document.querySelector<HTMLButtonElement>(".exec-approval-actions button.danger");
    const openConfirmation = async () => {
      forget()?.click();
      await waitForPage(() => expect(confirm()).not.toBeNull());
    };
    expect(forget()).toBeDefined();
    await openConfirmation();
    document
      .querySelector<HTMLButtonElement>(".exec-approval-actions button:not(.danger)")
      ?.click();
    await waitForPage(() => expect(document.querySelector(".exec-approval-actions")).toBeNull());
    expect(gateway.forgetDeviceToken).not.toHaveBeenCalled();
    await openConfirmation();
    expect(document.querySelector(".exec-approval-sub")?.textContent).toContain(
      "gateway.example.test",
    );
    if (stale) {
      gateway.connection.gatewayUrl = "wss://other.example.test";
    }
    confirm()?.click();
    if (stale) {
      await waitForPage(() => expect(document.querySelector(".exec-approval-actions")).toBeNull());
      expect(gateway.forgetDeviceToken).not.toHaveBeenCalled();
      return;
    }
    await waitForPage(() => expect(gateway.forgetDeviceToken).toHaveBeenCalledOnce());
    await waitForPage(() => expect(forget()).toBeUndefined());
  },
);

it("shares lazy-route polling with the tray and stops while hidden or disposed", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  stubResizeObserver();
  const setVisibility = mockVisibility();
  const request = vi.fn().mockResolvedValue(gatewaySystemInfo);
  const current = source(makeClient(request));
  Object.assign(current.gateway, {
    eventLog: [],
    subscribeEventLog: () => () => undefined,
  });
  const { provider, unmount } = await mount(current.gateway, { attached: false });
  const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
  expect(provider.isConnected).toBe(false);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["system.info"]);
  document.body.append(provider);
  flush();
  expect(statusReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  const overlay = document.createElement("openclaw-debug-overlay") as DebugOverlayElement & {
    readonly updateComplete: Promise<boolean>;
  };
  provider.append(overlay);
  overlay.open("minimized");
  await settleLitElement(overlay);
  await vi.advanceTimersByTimeAsync(0);
  expect(statusReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(55_000);
  expect(statusReads()).toHaveLength(7);
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statusReads()).toHaveLength(7);
  setVisibility("visible");
  globalThis.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(statusReads()).toHaveLength(8);
  unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statusReads()).toHaveLength(8);
});

it("shows average and nearest-rank percentiles for the last 100 successful round trips", async () => {
  vi.useFakeTimers();
  mockVisibility();
  const elapse = mockClock();
  const durations = [9_999, ...Array.from({ length: 100 }, (_, index) => 100 - index)];
  const pingRequest = vi.fn().mockImplementation(async () => {
    elapse(durations.shift()!);
    return null;
  });
  const { check } = await setup(undefined, pingRequest);
  await check({ average: "9999.0 ms" });
  await vi.advanceTimersByTimeAsync(1_000_000);
  await check({
    average: "50.5 ms",
    p50: "50.0 ms",
    p95: "95.0 ms",
    p99: "99.0 ms",
    ping: contains("Samples: 100/100"),
  });
});

it("keeps one ping in flight, excludes failures and hidden responses, and cancels on exit", async () => {
  vi.useFakeTimers();
  const setVisibility = mockVisibility();
  const elapse = mockClock();
  const responses = Array.from({ length: 5 }, () => deferred<null>());
  let nextResponse = 0;
  const pingRequest = vi.fn().mockImplementation(() => responses[nextResponse++]!.promise);
  const { page, check, unmount } = await setup(undefined, pingRequest);
  expect(text(page, ".connection-ping")).toContain("Measuring ping…");
  elapse(20);
  responses[0]!.resolve(null);
  await check({ average: "20.0 ms" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pingRequest).toHaveBeenCalledTimes(2);
  expect(pingRequest.mock.calls[1]?.[2]).toEqual({
    timeoutMs: 10_000,
    signal: expect.any(AbortSignal),
  });
  responses[1]!.reject(new Error("Gateway request timed out"));
  await check({ ping: contains("Last ping failed."), average: "20.0 ms" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pingRequest).toHaveBeenCalledTimes(3);
  setVisibility("hidden");
  expect(pingRequest.mock.calls[2]?.[2].signal.aborted).toBe(true);
  elapse(9_980);
  responses[2]!.resolve(null);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pingRequest).toHaveBeenCalledTimes(3);
  await check({ ping: contains("Samples: 1/100") });
  setVisibility("visible");
  elapse(40);
  responses[3]!.resolve(null);
  await check({ average: "30.0 ms", ping: excludes("Last ping failed.") });
  await vi.advanceTimersByTimeAsync(10_000);
  unmount();
  expect(pingRequest.mock.calls[4]?.[2].signal.aborted).toBe(true);
  responses[4]!.resolve(null);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pingRequest).toHaveBeenCalledTimes(5);
});

it.each(["reconnect", "source", "client", "source error", "source queued"] as const)(
  "retires diagnostics and reconciles drafts after a %s change",
  async (change) => {
    vi.useFakeTimers();
    mockVisibility();
    const elapse = mockClock();
    const stale = deferred<null>();
    const fresh = deferred<null>();
    const staleStatus = deferred<SystemInfoResult>();
    const freshStatus = deferred<SystemInfoResult>();
    const systemInfoRequest = vi
      .fn()
      .mockResolvedValueOnce(gatewaySystemInfo)
      .mockReturnValueOnce(staleStatus.promise)
      .mockReturnValueOnce(freshStatus.promise);
    const pingRequest = vi
      .fn()
      .mockImplementationOnce(async () => {
        elapse(20);
        return null;
      })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const client = makeClient(systemInfoRequest);
    const first = source(client, pingRequest);
    const credentials = { token: "replacement-token", password: "replacement-password" };
    Object.assign(first.gateway.connection, credentials);
    const { page, check, context, setContext } = await mount(first.gateway);
    editInput(page, "Gateway secret", "draft-secret");
    editInput(page, "Default session", "draft-session");
    control(page, 'button[aria-label="Toggle secret visibility"]').click();
    await check({ average: "20.0 ms", activity: contains("432 MB"), secretType: "text" });
    await vi.advanceTimersByTimeAsync(10_000);
    if (change === "reconnect") {
      publish(first, { phase: "reconnecting" });
      await check({ ping: undefined, secretType: "password", hostName: "—" });
      publish(first, {
        phase: "connected",
        sessionKey: "remote-session",
        hello: gatewayHelloForMethods(["system.info"]),
      });
      await check({ secret: "draft-secret", session: "draft-session" });
    } else if (change.startsWith("source")) {
      if (change === "source queued") {
        staleStatus.resolve({ ...gatewaySystemInfo, machineName: "Stale" });
      }
      const second = source(client, pingRequest);
      Object.assign(second.gateway.connection, credentials);
      setContext({ ...context, gateway: second.gateway });
      await check({ secret: "replacement-token", session: "main", secretType: "password" });
    } else {
      publish(first, {
        client: source(makeClient(systemInfoRequest), pingRequest).gateway.snapshot.client,
      });
    }
    await waitForPage(() => {
      expect(pingRequest.mock.calls[1]?.[2].signal.aborted).toBe(true);
      expect(systemInfoRequest.mock.calls[1]?.[2].signal.aborted).toBe(true);
    });
    elapse(500);
    stale.resolve(null);
    if (change === "source error") {
      staleStatus.reject(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: system.info",
        }),
      );
    } else {
      staleStatus.resolve({ ...gatewaySystemInfo, machineName: "Stale" });
    }
    await check({
      average: "—",
      activity: excludes("432 MB"),
      ping: contains("Measuring ping…"),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(systemInfoRequest).toHaveBeenCalledTimes(3);
    if (change.startsWith("source")) {
      await check({ hostSkeleton: expect.any(HTMLElement), hostName: excludes("Stale") });
    }
    elapse(10);
    fresh.resolve(null);
    freshStatus.resolve({
      ...deviceSystemInfo,
      machineName: "Current",
      eventLoop: { ...gatewayActivity.eventLoop, cpuCoreRatio: 0.7, delayP99Ms: 5 },
    });
    await check({
      average: "510.0 ms",
      ping: contains("Samples: 1/100"),
      activity: contains("70%"),
      hostName: "Current",
    });
  },
);

it("shares one host and activity poll independently of ping and reports failed refreshes", async () => {
  vi.useFakeTimers();
  const setVisibility = mockVisibility();
  const initial = deferred<SystemInfoResult>();
  const next = deferred<SystemInfoResult>();
  const recovery = deferred<SystemInfoResult>();
  const systemInfoRequest = vi
    .fn()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(next.promise)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockReturnValueOnce(recovery.promise)
    .mockResolvedValue(gatewaySystemInfo);
  const { page, state, check, tick, unmount } = await setup(systemInfoRequest);
  expect(state().placeholders).toBeGreaterThan(0);
  expect(state().busy).toBe("true");
  initial.resolve(gatewaySystemInfo);
  await check({ placeholders: 0, busy: "false", hostName: "Gateway" });
  const hostElement = state().hostElement;
  const sessionInput = input(page, "Default session");
  const url = input(page, "Gateway URL");
  const secret = input(page, "Gateway secret");
  const details = page.querySelector<HTMLDetailsElement>("details")!;
  details.open = true;
  editInput(page, "Default session", "kept-session");
  sessionInput.focus();
  expect(state().activity).toContain("432 MB");
  expect(state().activity).toContain("42%");
  await vi.advanceTimersByTimeAsync(10_000);
  await check({ placeholders: 0, busy: "true", hostName: "Gateway" });
  expect(state().hostElement).toBe(hostElement);
  expect(input(page, "Default session")).toBe(sessionInput);
  expect(sessionInput.value).toBe("kept-session");
  expect(document.activeElement).toBe(sessionInput);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(systemInfoRequest).toHaveBeenCalledTimes(2);
  next.resolve({
    ...gatewaySystemInfo,
    machineName: "Fresh host",
    eventLoop: {
      ...gatewayActivity.eventLoop,
      cpuCoreRatio: 0.6,
      delayP99Ms: 50,
      reasons: ["cpu"],
    },
  });
  await check({
    activity: contains("60%"),
    hostName: contains("Fresh host"),
    cpuDegraded: true,
  });
  await tick(10_000, {
    activityFailed: true,
    placeholders: 0,
    busy: "false",
    hostName: "Fresh host",
    activity: contains("60%"),
  });
  await tick(10_000, { activityFailed: true, busy: "true" });
  url.focus();
  url.setSelectionRange(4, 7);
  recovery.resolve(gatewaySystemInfo);
  await check({ activityFailed: false, busy: "false" });
  expect(state().hostElement).toBe(hostElement);
  expect(sessionInput.value).toBe("kept-session");
  expect(input(page, "Gateway URL")).toBe(url);
  expect(input(page, "Gateway secret")).toBe(secret);
  expect(document.activeElement).toBe(url);
  expect([url.selectionStart, url.selectionEnd]).toEqual([4, 7]);
  expect(page.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  const hidden = deferred<SystemInfoResult>();
  systemInfoRequest.mockReturnValueOnce(hidden.promise);
  await vi.advanceTimersByTimeAsync(10_000);
  setVisibility("hidden");
  expect(systemInfoRequest.mock.calls[4]?.[2].signal.aborted).toBe(true);
  hidden.resolve({ ...gatewaySystemInfo, machineName: "Hidden stale host" });
  await tick(10_000, { calls: 5, hostName: excludes("Hidden stale host") });
  setVisibility("visible");
  await check({ calls: 6 });
  unmount();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(systemInfoRequest).toHaveBeenCalledTimes(6);
});

function editInput(page: HTMLElement, label: string, value: string) {
  const field = input(page, label);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it.each([
  ["saved-token", "saved-password", "secret"],
  ["", "injected-password", "secret"],
  ["old-token", "old-password", "url"],
])(
  "replaces credentials without retaining a hidden secret: %s / %s",
  async (token, password, change) => {
    const displayed = token || password;
    const current = source();
    const authMode = token ? "token" : "password";
    publish(current, { hello: authHello(authMode) });
    Object.assign(current.gateway.connection, {
      gatewayUrl: "wss://gateway.example/openclaw",
      token,
      password,
    });
    const connect = vi.spyOn(current.gateway, "connect");
    const { page } = await mount(current.gateway);
    const secret = () => input(page, "Gateway secret");
    expect(page.querySelectorAll(".settings-secret input")).toHaveLength(1);
    expect(secret()).toMatchObject({
      value: displayed,
      type: "password",
      placeholder: "Paste the token or type the password",
    });
    expect(page.textContent).toContain(`This Gateway expects its ${authMode}.`);
    expect(page.querySelector('[role="radiogroup"]')).toBeNull();
    control(page, ".connection-details button").click();
    expect(connect).toHaveBeenLastCalledWith();
    const changedUrl = change === "url";
    const gatewayUrl = "wss://gateway.example/openclaw";
    const otherUrl = "wss://other-gateway.example/openclaw";
    editInput(page, changedUrl ? "Gateway URL" : "Gateway secret", changedUrl ? otherUrl : "");
    await waitForPage(() => expect(secret().value).toBe(""));
    if (!changedUrl) {
      editInput(page, "Gateway secret", "edited-secret");
      flush();
    }
    control(page, "button.btn.primary").click();
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gatewayUrl: changedUrl ? otherUrl : gatewayUrl,
        token: changedUrl ? "" : "edited-secret",
        password: "",
      }),
    );
  },
);

it("offers connection actions only while the draft differs", async () => {
  const { page } = await setup();
  const labels = () =>
    [...page.querySelectorAll(".connection-actions button")].map((button) =>
      button.textContent?.trim(),
    );
  expect(labels()).toEqual([]);
  editInput(page, "Gateway secret", "draft-token");
  await waitForPage(() => expect(labels()).toEqual(["Discard changes", "Apply and reconnect"]));
  editInput(page, "Gateway secret", "");
  await waitForPage(() => expect(labels()).toEqual([]));
  editInput(page, "Gateway secret", "draft-token");
  flush();
  control(page, ".connection-actions button").click();
  await waitForPage(() => {
    expect(input(page, "Gateway secret").value).toBe("");
    expect(labels()).toEqual([]);
  });
});

it("saves and discards session edits independently of the pending connection", async () => {
  const current = source();
  const connect = vi.spyOn(current.gateway, "connect");
  current.gateway.setSessionKey = vi.fn((sessionKey) => {
    publish(current, { sessionKey: sessionKey.trim() });
  });
  const { page, check } = await mount(current.gateway);
  const sessionSection = input(page, "Default session").closest(".settings-section")!;
  const button = (name: string) => findButton(sessionSection, name)!;
  editInput(page, "Gateway secret", "pending-token");
  editInput(page, "Default session", "main-other");
  flush();
  editInput(page, "Default session", "main");
  await waitForPage(() => expect(sessionSection.querySelector("button")).toBeNull());
  editInput(page, "Default session", "  saved-session  ");
  flush();
  button("Save").click();
  await check({ session: "saved-session", secret: "pending-token" });
  expect(current.gateway.snapshot.sessionKey).toBe("saved-session");
  expect(page.textContent).toContain("Saved");
  expect(connect).not.toHaveBeenCalled();
  editInput(page, "Default session", " ");
  await waitForPage(() => expect(button("Save").disabled).toBe(true));
  button("Discard changes").click();
  await check({ session: "saved-session" });
});

it("stops polling after a missing-read-scope error", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce(deviceSystemInfo)
    .mockRejectedValueOnce(missingReadScopeErrorFixture())
    .mockResolvedValue(deviceSystemInfo);
  const { check } = await setup(request);
  await vi.advanceTimersByTimeAsync(10_000);
  await check({ hostName: null });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["advertisement", "scope"] as const)(
  "retires a pending host read when its %s disappears",
  async (change) => {
    const response = deferred<SystemInfoResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValue(deviceSystemInfo);
    const { check, ...current } = await setup(request);
    publish(current, {
      hello: gatewayHelloForMethods(
        change === "advertisement" ? [] : ["system.info"],
        change === "scope" ? ["operator.sessions.read"] : ["operator.admin"],
      ),
    });
    response.resolve(deviceSystemInfo);
    await check({ hostElement: null });
    publish(current, {
      hello: gatewayHelloForMethods(["system.info"]),
    });
    await check({ hostName: "Gateway", calls: 2 });
  },
);

it("hides ingress credentials while preserving connection errors and recovery", async () => {
  document.documentElement.dataset.openclawRemoteIngress = "true";
  const { page } = await display({ phase: "offline", lastError: "Ingress unavailable" });
  expect(page.querySelector('[aria-label="Gateway URL"]')).toBeNull();
  expect(page.querySelector('[aria-label="Gateway secret"]')).toBeNull();
  expect(page.textContent).toContain("Ingress unavailable");
  expect(text(page, ".connection-actions button")?.trim()).toBe("Retry connection");
});

it("disables connection actions while starting and hides errors after connection", async () => {
  const current = await display({ phase: "starting", lastError: "connect failed: unauthorized" });
  const { page } = current;
  expect(control(page, ".connection-actions .btn.primary").disabled).toBe(true);
  expect(text(page, ".connection-actions .btn.primary")?.trim()).toBe("Connecting…");
  expect(control(page, "details button").disabled).toBe(true);
  const error = page.querySelector(".settings-status--danger")!;
  expect(error.textContent).toContain("Last error");
  expect(page.textContent).toContain("connect failed: unauthorized");
  expect(error.closest(".settings-section")?.querySelector("h2")?.textContent).toBe("Connection");
  publish(current, { phase: "connected" });
  await waitForPage(() => expect(page.querySelector(".settings-status--danger")).toBeNull());
  expect(page.textContent).not.toContain("connect failed: unauthorized");
});

it("shows setup-code guidance only for a mobile setup code", async () => {
  const { page } = await display();
  const hint = () =>
    input(page, "Gateway secret")
      .closest(".settings-row__control")
      ?.querySelector('[role="status"]');
  editInput(
    page,
    "Gateway secret",
    btoa(
      JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "synthetic-bootstrap-token" }),
    ).replace(/=+$/g, ""),
  );
  await waitForPage(() =>
    expect(hint()?.textContent).toContain("device setup code for the OpenClaw mobile app"),
  );
  expect(page.textContent).toContain("openclaw gateway auth-token --show");
  editInput(page, "Gateway secret", "tok");
  await waitForPage(() => expect(hint()).toBeNull());
});

it("scopes trusted-proxy credentials to the live target", async () => {
  const { page } = await display({ hello: authHello("trusted-proxy") });
  expect(page.querySelector('[aria-label="Gateway secret"]')).toBeNull();
  expect(text(page, ".settings-row .settings-status")?.trim()).toBe("Trusted proxy");
  expect(page.textContent).toContain("Authenticated via trusted proxy.");
  editInput(page, "Gateway URL", "wss://other.example");
  await waitForPage(() => expect(input(page, "Gateway secret")).toBeDefined());
  expect(page.textContent).not.toContain("Authenticated via trusted proxy.");
});

it("renders host identity and resource meters, including disk removal", async () => {
  vi.useFakeTimers();
  const disks = [
    { path: "/", totalBytes: 1024 ** 4, availableBytes: 512 * 1024 ** 3 },
    { path: "/archive", totalBytes: 2 * 1024 ** 4, availableBytes: 512 * 1024 ** 3 },
  ];
  const info = {
    ...deviceSystemInfo,
    lanAddress: "192.168.1.20",
    port: 18789,
    cpuModel: "Apple M4",
    diskPath: "/legacy",
    diskTotalBytes: 1000,
    diskAvailableBytes: 500,
    disks,
  };
  const request = vi.fn().mockResolvedValue(info);
  const { page, check, tick } = await setup(request);
  await check({ hostName: "Gateway" });
  expect(page.querySelector(".config-host__name")).toMatchObject({ title: "gateway.test" });
  expect(text(page, ".config-host__address")).toBe("192.168.1.20:18789");
  expect([...page.querySelectorAll(".config-host__meta")].map((node) => node.textContent)).toEqual([
    "macOS 26.0 · arm64",
    "Node 24.15.0 · PID 100",
  ]);
  expect(text(page, "#settings-connection-host .settings-status")).toBe("Up 1d");
  const stats = [...page.querySelectorAll(".config-host__stat")];
  expect(stats[0]?.textContent).toContain("8 cores");
  expect(stats[1]?.textContent).toContain("12 GB free of 32 GB");
  expect(stats[2]?.textContent).toContain("512 GB free of 1.0 TB");
  expect(stats[3]?.textContent).toContain("512 GB free of 2.0 TB");
  expect(stats[0]?.getAttribute("title")).toBe("Apple M4 · Load average: 1.5 · 1.2 · 1.0");
  expect(
    stats.map((node) => node.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")),
  ).toEqual(["19", "63", "50", "75"]);
  expect(
    stats.slice(2).map((node) => node.querySelector('[role="meter"]')?.getAttribute("aria-label")),
  ).toEqual(["Disk / usage", "Disk /archive usage"]);
  for (const remaining of [disks.slice(0, 1), [], undefined]) {
    request.mockResolvedValue({ ...info, disks: remaining });
    await tick(10_000, { hostName: "Gateway" });
    await waitForPage(() =>
      expect(page.querySelectorAll(".config-host__stat")).toHaveLength(
        2 + (remaining?.length ?? 0),
      ),
    );
    expect(page.textContent).not.toContain("/archive");
    expect(page.textContent).not.toContain("/legacy");
  }
  request.mockResolvedValue({
    ...info,
    loadAverage: [7.8, 7.1, 6.4],
    memoryFreeBytes: 2 * 1024 ** 3,
    disks: [{ path: "/", totalBytes: 1000, availableBytes: 200 }],
  });
  await tick(10_000, { hostName: "Gateway" });
  await waitForPage(() =>
    expect(
      [...page.querySelectorAll(".config-host__meter-fill")].map((node) => node.classList[1]),
    ).toEqual([
      "config-host__meter-fill--critical",
      "config-host__meter-fill--critical",
      "config-host__meter-fill--warn",
    ]),
  );
});
