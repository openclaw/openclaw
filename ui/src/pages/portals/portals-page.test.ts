/* @vitest-environment jsdom */

import type {
  EnvironmentSummary,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PortalPanelToggleDetail } from "../../components/panel-toggle-contract.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { PortalReachability } from "./portal-reachability.ts";

const probePortalReachable = vi.hoisted(() => vi.fn<() => Promise<PortalReachability>>());
vi.mock("./portal-reachability.ts", () => ({ probePortalReachable }));

import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import "./portals-page.tsx";
import type { PortalsPageProps } from "./portals-page.tsx";

const portal = {
  id: "p3000",
  title: "Seeded app",
  port: 3000,
  listenPort: 43_123,
  tokenQuery: "openclaw_portal=secret-token",
  url: "https://preview.example.test:8443/context/app?view=one%2Ftwo&openclaw_portal=secret-token#section",
  publicUrl: "https://preview.example.test:8443/context/app?view=one%2Ftwo#section",
  description: "Use the seeded test account.",
  createdAtMs: 1_000,
} satisfies PortalSummary;
const portalMethods = ["portal.list", "portal.close"];
const environmentMethods = ["environments.status", "portal.list"];
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
function createContext(methods: string[] | null, request: Request, scopes = ["operator.write"]) {
  const requestMock = vi.fn(request);
  const { gateway, publish, publishEvent } = createApplicationGateway();
  const hello = gatewayHelloForMethods(methods ?? [], scopes);
  if (!methods) {
    hello.features = undefined;
  }
  function updateSnapshot(update: Partial<ApplicationGatewaySnapshot>) {
    publish(Object.assign(gateway.snapshot, update));
  }
  updateSnapshot({
    client: { request: requestMock } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello,
    sessionKey: "main",
  });
  gateway.connection.gatewayUrl = "wss://gateway.example.test:18789/control";
  return {
    context: { gateway } as unknown as ApplicationContext,
    updateSnapshot,
    emitPortals(portals: PortalSummary[]) {
      publishEvent({ type: "event", event: "portal.changed", payload: { portals } });
    },
    request: requestMock,
  };
}

type Source = ReturnType<typeof createContext>;
type Page = HTMLElementTagNameMap["openclaw-portals-page"];
const frameOf = (page: Page) => page.querySelector("iframe");
const button = (page: Page, label: string) =>
  page.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const menuItem = (page: Page, label: string) =>
  page.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"]`);
const retryButton = (page: Page) =>
  [...page.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Retry")!;
const closeButton = (page: Page) =>
  page.querySelector<HTMLButtonElement>(".portals-preview__close")!;
const waitForText = (page: Page, text: string) =>
  waitForSolid(() => expect(page.textContent).toContain(text));
const waitForFrame = (page: Page) => waitForSolid(() => expect(frameOf(page)).not.toBeNull());
const waitForTitle = (page: Page, title: string) =>
  waitForSolid(() => expect(frameOf(page)?.title).toBe(`${title} portal preview`));
const toggle = (page: Page, detail: PortalPanelToggleDetail) =>
  page.handleToggleRequest(
    new CustomEvent("openclaw:portal-toggle", { detail: { open: true, ...detail } }),
  );
const usePollingTimers = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
const machine = (
  id: string,
  status: EnvironmentSummary["status"] = "starting",
): EnvironmentSummary => ({ id, type: "worker", status });
const portalResponse = (value: PortalSummary = portal) => ({ portals: [value] });
const callsTo = (source: Source, method: string) =>
  source.request.mock.calls.filter(([name]) => name === method);
const waitForRequest = (source: Source, method: string, params: unknown) =>
  waitForSolid(() => expect(source.request).toHaveBeenCalledWith(method, params));
function updatePage(page: Page, props: Partial<PortalsPageProps>) {
  return Object.assign(page, props).updateComplete;
}
async function expectNoPolling(source: Source) {
  const reads = source.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6_000);
  expect(source.request).toHaveBeenCalledTimes(reads);
}
const closeContext = (result: Promise<unknown> | { closed: boolean }) =>
  createContext(portalMethods, async (name) =>
    name === "portal.list" ? portalResponse() : result,
  );
async function mountPage(context: ApplicationContext, portalId?: string, environmentId?: string) {
  const page = Object.assign(document.createElement("openclaw-portals-page"), {
    embedded: Boolean(portalId || environmentId),
    requestedPortalId: portalId ?? null,
    requestedEnvironmentId: environmentId ?? null,
  });
  const provider = createApplicationContextProvider(context);
  provider.append(page);
  mountSolid(() => provider);
  await page.updateComplete;
  return { page, provider };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => void probePortalReachable.mockReset().mockResolvedValue("reachable"));

it.each(["portal.list", "environments.status"] as const)("retries %s", async (method) => {
  const isPortal = method === "portal.list";
  const first = createDeferred<PortalListResult | EnvironmentSummary>();
  const retry = createDeferred<PortalListResult | EnvironmentSummary>();
  const source = createContext([method], async () => retry.promise);
  source.request.mockReturnValueOnce(first.promise);
  const { page } = await mountPage(
    source.context,
    isPortal ? portal.id : undefined,
    isPortal ? undefined : "pending-machine",
  );
  const loading = isPortal ? "Loading" : "Starting your machine";
  await waitForText(page, loading);
  if (isPortal) {
    await updatePage(page, { presented: false });
    await updatePage(page, { presented: true });
    await waitForText(page, loading);
  }
  first.reject(new Error("Synthetic read unavailable"));
  await waitForText(page, "Synthetic read unavailable");
  retryButton(page).click();
  await waitForText(page, loading);
  expect(page.textContent).not.toContain("Synthetic read unavailable");
  retry.resolve(isPortal ? portalResponse() : machine("pending-machine", "available"));
  if (isPortal) {
    await waitForFrame(page);
  } else {
    await waitForText(page, "Waiting for your application");
  }
});

it.each(["catalogued", "uncatalogued", "unsupported"])(
  "connected empty state: %s",
  async (mode) => {
    const methods = mode === "unsupported" ? [] : ["portal.list"];
    const source = createContext(
      mode === "uncatalogued" ? null : methods,
      async () => ({ portals: [] }),
      ["operator.read"],
    );
    const hello = source.context.gateway.snapshot.hello;
    source.updateSnapshot({ phase: "reconnecting", hello: null });
    const { page } = await mountPage(source.context);
    expect(page.textContent).not.toContain("Ask the agent to start a portal:");
    expect(source.request).not.toHaveBeenCalled();

    source.updateSnapshot({ phase: "connected", hello });
    await waitForText(page, "Ask the agent to start a portal:");
    if (mode === "unsupported") {
      expect(page.textContent).toContain("This gateway does not support portals.");
      expect(source.request).not.toHaveBeenCalled();
    } else {
      await waitForRequest(source, "portal.list", {});
    }
  },
);

it.each(["client", "account", "recovery"] as const)(
  "retains selection across reconnect, then retires the frame for a new %s",
  async (identity) => {
    const selected = { ...portal, id: "selected", title: "Selected app" };
    const initial = [portal, selected];
    const refreshed = createDeferred<PortalListResult>();
    const replacement = createDeferred<PortalListResult>();
    const hello = gatewayHelloForMethods(portalMethods);
    hello.auth = { ...hello.auth, recoveryScope: "first-scope" };
    const source = createContext(portalMethods, async () => replacement.promise);
    source.request
      .mockResolvedValueOnce({ portals: initial })
      .mockReturnValueOnce(refreshed.promise);
    source.updateSnapshot({ hello, selfUser: { id: "first-user", name: "First user" } });
    const { page } = await mountPage(source.context);
    await waitForFrame(page);
    const selectedButton = page.querySelectorAll<HTMLButtonElement>(".portals-rail__item")[1]!;
    selectedButton.click();
    await waitForTitle(page, selected.title);
    const frame = frameOf(page)!;
    source.updateSnapshot({ phase: "reconnecting", hello: null });
    await page.updateComplete;
    expect(frameOf(page)).toBe(frame);
    expect(selectedButton.getAttribute("aria-current")).toBe("true");
    expect(closeButton(page)?.disabled).toBe(true);

    source.updateSnapshot({ phase: "connected", hello });
    refreshed.resolve({
      portals: [portal, { ...selected, title: "Refreshed selection" }],
    });
    await waitForSolid(() => expect(frame.title).toBe("Refreshed selection portal preview"));
    expect(frameOf(page)).toBe(frame);

    source.updateSnapshot(
      identity === "client"
        ? { client: createTestGatewayClient(() => replacement.promise) }
        : identity === "account"
          ? { selfUser: { id: "second-user", name: "Second user" } }
          : { hello: { ...hello, auth: { ...hello.auth, recoveryScope: "second-scope" } } },
    );
    await page.updateComplete;
    expect(frameOf(page)).toBeNull();
    replacement.resolve({ portals: initial });
    await waitForTitle(page, portal.title);
    expect(frameOf(page)).not.toBe(frame);
    const currentHello = source.context.gateway.snapshot.hello;
    source.updateSnapshot({ phase: "reconnecting", hello: null });
    await page.updateComplete;
    toggle(page, { portalId: selected.id });
    await waitForText(page, "Loading portals");
    expect(frameOf(page)).toBeNull();
    source.updateSnapshot({ phase: "connected", hello: currentHello });
    await waitForTitle(page, selected.title);
  },
);

it("refreshes the embedded frame and keeps Portal actions scoped across desktop and mobile", async () => {
  let listed: PortalSummary[] = [portal];
  const source = createContext(portalMethods, async (method) => {
    if (method === "portal.close") {
      listed = [];
      return { closed: true };
    }
    return { portals: listed };
  });
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const { page } = await mountPage(source.context, portal.id);
    await waitForFrame(page);
    const original = frameOf(page)!;
    expect(original.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(original.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
    expect(page.querySelector(".portals-embedded__origin")?.textContent).toBe(
      "https://preview.example.test:8443",
    );
    const pending = createDeferred<PortalReachability>();
    probePortalReachable.mockReturnValueOnce(pending.promise);
    const refresh = button(page, "Refresh")!;
    refresh.click();
    await waitForSolid(() => expect(frameOf(page)).toBeNull());
    expect(refresh.disabled).toBe(true);
    pending.resolve("reachable");
    await waitForFrame(page);
    const replacement = frameOf(page)!;
    expect(replacement).not.toBe(original);
    expect(replacement.src).toBe(portal.url);
    expect(replacement.getAttribute("sandbox")).toBe(original.getAttribute("sandbox"));
    const openOptions = async () => {
      button(page, "Portal options")!.click();
      await waitForSolid(() =>
        expect(page.querySelector('[role="menu"]')?.getAttribute("data-state")).toBe("open"),
      );
    };
    await openOptions();
    menuItem(page, "Copy link")!.click();
    await waitForSolid(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(portal.publicUrl));
    page.mobile = true;
    await page.updateComplete;
    expect(button(page, "Refresh")).toBeNull();
    await openOptions();
    expect(menuItem(page, "Copy link")).toBeNull();
    expect(menuItem(page, "Open in browser")?.getAttribute("href")).toBe(portal.url);
    source.updateSnapshot({ hello: gatewayHelloForMethods(portalMethods, ["operator.read"]) });
    await page.updateComplete;
    const denied = menuItem(page, "Close portal")!;
    expect(denied.getAttribute("aria-disabled")).toBe("true");
    denied.click();
    expect(callsTo(source, "portal.close")).toHaveLength(0);
    source.updateSnapshot({ hello: gatewayHelloForMethods(portalMethods, ["operator.write"]) });
    await page.updateComplete;
    menuItem(page, "Close portal")!.click();
    await waitForRequest(source, "portal.close", { id: portal.id });
    await waitForSolid(() => expect(frameOf(page)).toBeNull());
  } finally {
    restorePropertyDescriptor(navigator, "clipboard", clipboard);
  }
});

it.each([undefined, "pending-machine"])("revokes read access: %s", async (environmentId) => {
  usePollingTimers();
  const source = createContext(environmentMethods, async () =>
    environmentId ? machine(environmentId) : portalResponse(),
  );
  const { page } = await mountPage(source.context, undefined, environmentId);
  await waitForSolid(() => expect(source.request).toHaveBeenCalledOnce());
  source.updateSnapshot({ phase: "reconnecting" });
  await page.updateComplete;
  expect(page.textContent).not.toContain("This action requires operator.read access.");
  source.updateSnapshot({
    phase: "connected",
    hello: gatewayHelloForMethods(environmentMethods, ["operator.sessions.read"]),
  });
  await page.updateComplete;
  source.emitPortals([portal]);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(source.request).toHaveBeenCalledTimes(1);
  expect(page.textContent).toContain("This action requires operator.read access.");
  expect(frameOf(page)).toBeNull();
  expect(page.textContent).not.toContain("Starting your machine");
});

it.each(["success", "failure"] as const)("coalesces startup %s", async (outcome) => {
  usePollingTimers();
  const retired = createDeferred<EnvironmentSummary>();
  let replacement = machine("new-machine");
  const source = createContext(environmentMethods, async (method, params) =>
    method === "portal.list"
      ? portalResponse()
      : params.environmentId === "old-machine"
        ? retired.promise
        : replacement,
  );
  const { page } = await mountPage(source.context, portal.id);
  await waitForFrame(page);
  toggle(page, { environmentId: "old-machine" });
  await waitForRequest(source, "environments.status", { environmentId: "old-machine" });
  source.request.mockClear();
  for (const environmentId of ["intermediate-machine", replacement.id]) {
    toggle(page, { environmentId });
  }
  await waitForSolid(() =>
    expect(source.request.mock.calls).toEqual([
      ["environments.status", { environmentId: replacement.id }],
    ]),
  );
  await waitForText(page, "Starting your machine");
  if (outcome === "success") {
    await updatePage(page, { presented: false });
    retired.resolve(machine("old-machine", "available"));
    await expectNoPolling(source);
    expect(page.textContent).toContain("Starting your machine");
    replacement = { ...replacement, status: "error" };
    await updatePage(page, { presented: true });
    await waitForText(page, "The machine could not start");
  } else {
    retired.reject(new Error("Previous machine failed"));
    await retired.promise.catch(() => undefined);
    await page.updateComplete;
    expect(page.textContent).not.toContain("Previous machine failed");
    replacement = { ...replacement, status: "available" };
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;
    expect(page.textContent).toContain("Waiting for your application");
  }
  expect(frameOf(page)).toBeNull();
  await expectNoPolling(source);
  expect(callsTo(source, "portal.list")).toHaveLength(0);
  if (outcome === "failure") {
    toggle(page, { portalId: portal.id });
    await waitForTitle(page, portal.title);
    expect(page.requestedEnvironmentId).toBeNull();
  }
  page.remove();
  await expectNoPolling(source);
});

it.each(["success", "failure"] as const)("ignores a retired close %s", async (outcome) => {
  const retired = createDeferred<{ closed: boolean }>();
  const current = createDeferred<{ closed: boolean }>();
  const source = closeContext(retired.promise);
  const replacement = closeContext(current.promise);
  const { page } = await mountPage(source.context);
  const close = () => closeButton(page);
  await waitForSolid(() => expect(close()).not.toBeNull());
  close().click();
  await waitForSolid(() => expect(close().disabled).toBe(true));
  source.updateSnapshot({ client: replacement.context.gateway.snapshot.client });
  await waitForSolid(() => expect(close()?.disabled).toBe(false));
  close().click();
  await waitForSolid(() => expect(close().disabled).toBe(true));
  if (outcome === "success") {
    retired.resolve({ closed: true });
  } else {
    retired.reject(new Error("Retired close failed"));
  }
  await retired.promise.catch(() => undefined);
  await page.updateComplete;
  expect(close().disabled).toBe(true);
  expect(page.textContent).not.toContain("Retired close failed");
  close().click();
  expect(callsTo(replacement, "portal.close")).toHaveLength(1);
  current.resolve({ closed: true });
  await waitForSolid(() => expect(close().disabled).toBe(false));
});

it("requires write access instead of opening a portal without credentials", async () => {
  const source = createContext(
    ["portal.list"],
    async () => portalResponse({ ...portal, tokenQuery: undefined, url: undefined }),
    ["operator.read"],
  );
  const { page } = await mountPage(source.context);
  await waitForText(page, "This portal requires an operator with write access.");
  expect(frameOf(page)).toBeNull();
  expect(page.querySelector(".portals-preview__url")).toBeNull();
  expect(probePortalReachable).not.toHaveBeenCalled();
});

it("shows an unreachable notice without mounting the iframe and retries", async () => {
  const oldProbe = createDeferred<"reachable">();
  const pending = createDeferred<PortalReachability>();
  probePortalReachable
    .mockReturnValueOnce(oldProbe.promise)
    .mockResolvedValueOnce("unreachable")
    .mockReturnValueOnce(pending.promise);
  const first = closeContext({ closed: true });
  const source = closeContext({ closed: true });
  const { page, provider } = await mountPage(first.context);
  await waitForSolid(() => expect(probePortalReachable).toHaveBeenCalledOnce());
  provider.setContext(source.context);
  await waitForText(page, "Portal not reachable from this browser");
  oldProbe.resolve("reachable");
  await page.updateComplete;
  expect(page.textContent).toContain("Portal not reachable from this browser");
  expect(frameOf(page)).toBeNull();
  retryButton(page).click();
  await waitForText(page, "Loading portal");
  expect(page.textContent).not.toContain("Portal not reachable from this browser");
  expect(frameOf(page)).toBeNull();
  pending.resolve("reachable");
  await waitForFrame(page);
});

it.each([
  ["https://preview.example.test/", "reachable", "unverified", "network-reachable"],
  ["http://127.0.0.1:43123/", "reachable", "blocked", "remote-ingress-required"],
  ["http://preview.example.test:43123/", "reachable", "new-tab-required", "new-tab-required"],
  ["https://preview.example.test/", "unreachable", "blocked", "network-unreachable"],
  ["https://preview.example.test/", "blocked", "unverified", "probe-blocked"],
] as const)("reports %s / %s as %s (%s)", async (url, probe, status, reason) => {
  probePortalReachable.mockResolvedValue(probe);
  const source = createContext(["portal.list", "ui.command.result"], async (method) =>
    method === "portal.list"
      ? portalResponse({ ...portal, publicUrl: url, url: url + "?openclaw_portal=synthetic" })
      : { ok: true },
  );
  const { page } = await mountPage(source.context, portal.id);
  toggle(page, { portalId: portal.id, requestId: "request-one" });
  await waitForSolid(() =>
    expect(source.request).toHaveBeenCalledWith("ui.command.result", {
      requestId: "request-one",
      presentation: { portalId: portal.id, status, reason },
    }),
  );
  expect(callsTo(source, "ui.command.result")).toHaveLength(1);
});
