/* @vitest-environment jsdom */

import type {
  EnvironmentSummary,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { PortalPanelToggleDetail } from "../../components/panel-toggle-contract.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";

const probePortalReachable = vi.hoisted(() =>
  vi.fn<() => Promise<"reachable" | "unreachable" | "blocked">>(),
);

vi.mock("./portal-reachability.ts", () => ({ probePortalReachable }));

import { PortalsPage, type PortalsPageProps } from "./portals-page.tsx";

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

function createContext(
  methods: string[] | null,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  scopes = ["operator.write"],
) {
  const requestMock = vi.fn(request);
  const client = { request: requestMock } as unknown as GatewayBrowserClient;
  const { gateway, publish, publishEvent } = createApplicationGateway();
  const snapshot = Object.assign(gateway.snapshot, {
    client,
    phase: "connected",
    hello: methods
      ? gatewayHelloForMethods(methods, scopes)
      : { ...gatewayHelloForMethods([], scopes), features: undefined },
    sessionKey: "main",
  } satisfies Partial<ApplicationGatewaySnapshot>);
  gateway.connection.gatewayUrl = "wss://gateway.example.test:18789/control";
  return {
    context: { gateway } as unknown as ApplicationContext,
    updateSnapshot(update: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, update);
      publish(snapshot);
    },
    emitPortals(portals: PortalSummary[]) {
      publishEvent({ type: "event", event: "portal.changed", payload: { portals } });
    },
    request: requestMock,
  };
}

type Source = ReturnType<typeof createContext>;
type Page = HTMLElementTagNameMap["openclaw-portals-page"];
const frameOf = (page: Page) => page.querySelector("iframe");
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
const portalResponse = (value = portal) => ({ portals: [value] });
const callsTo = (source: Source, method: string) =>
  source.request.mock.calls.filter(([name]) => name === method);
const waitForRequest = (source: Source, method: string, params: unknown) =>
  waitForSolid(() => expect(source.request).toHaveBeenCalledWith(method, params));
const expectReceipt = (source: Source, requestId: string, status: string, reason: string) =>
  expect(source.request).toHaveBeenCalledWith("ui.command.result", {
    requestId,
    presentation: { portalId: portal.id, status, reason },
  });
async function updatePage(page: Page, props: Partial<PortalsPageProps>) {
  Object.assign(page, props);
  await page.updateComplete;
}
async function expectNoPolling(source: Source) {
  const reads = source.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6_000);
  expect(source.request).toHaveBeenCalledTimes(reads);
}
function actionContext(method: string, result: Promise<unknown> | { closed: boolean }) {
  return createContext(["portal.list", method], async (name) =>
    name === "portal.list" ? portalResponse() : result,
  );
}

async function mountPage(context: ApplicationContext, portalId?: string, environmentId?: string) {
  const provider = createSolidApplicationContextProvider(context);
  const { container } = mountSolid(
    () =>
      createComponent(PortalsPage, {
        embedded: Boolean(portalId || environmentId),
        requestedPortalId: portalId ?? null,
        requestedEnvironmentId: environmentId ?? null,
      }),
    { wrapper: provider.wrapper },
  );
  flush();
  const page = container.querySelector("openclaw-portals-page")!;
  await page.updateComplete;
  return page;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  probePortalReachable.mockReset().mockResolvedValue("reachable");
});

describe("PortalsPage", () => {
  it("waits for a confirmed portal list before showing the empty state", async () => {
    const source = createContext(["portal.list"], async () => ({ portals: [] }));
    source.updateSnapshot({ phase: "reconnecting", hello: null });
    const page = await mountPage(source.context);
    expect(page.textContent).not.toContain("Ask the agent to start a portal:");
    expect(source.request).not.toHaveBeenCalled();

    source.updateSnapshot({ phase: "connected", hello: gatewayHelloForMethods(["portal.list"]) });
    await waitForText(page, "Ask the agent to start a portal:");
    expect(source.request).toHaveBeenCalledOnce();
  });

  it.each(["client", "account", "recovery"] as const)(
    "retains selection across reconnect, then retires the frame for a new %s",
    async (identity) => {
      const selected = { ...portal, id: "p4000", title: "Selected app", port: 4000 };
      const initial = identity === "client" ? [portal, selected] : [portal];
      const selection = initial.at(-1)!;
      const refreshed = createDeferred<PortalListResult>();
      const replacement = createDeferred<PortalListResult>();
      const methods = identity === "client" ? ["portal.list", "portal.close"] : ["portal.list"];
      const hello = gatewayHelloForMethods(methods);
      hello.auth = { ...hello.auth, recoveryScope: "first-scope" };
      let reads = 0;
      const source = createContext(methods, async () =>
        ++reads === 1
          ? { portals: initial }
          : reads === 2
            ? refreshed.promise
            : replacement.promise,
      );
      source.updateSnapshot({ hello, selfUser: { id: "first-user", name: "First user" } });
      const page = await mountPage(source.context);
      await waitForFrame(page);
      const selectedButton = [
        ...page.querySelectorAll<HTMLButtonElement>(".portals-rail__item"),
      ].find((button) => button.textContent?.includes(selection.title))!;
      selectedButton.click();
      await waitForTitle(page, selection.title);
      const frame = frameOf(page)!;
      source.updateSnapshot({ phase: "reconnecting", hello: null });
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBe(frame);
      expect(selectedButton.getAttribute("aria-current")).toBe("true");
      expect(page.querySelector<HTMLButtonElement>(".portals-preview__close")?.disabled).toBe(true);
      expect(source.request).toHaveBeenCalledOnce();

      source.updateSnapshot({ phase: "connected", hello });
      await waitForSolid(() => expect(source.request).toHaveBeenCalledTimes(2));
      expect(page.querySelector("iframe")).toBe(frame);
      refreshed.resolve({
        portals: initial.map((entry) =>
          entry.id === selection.id ? { ...entry, title: "Refreshed selection" } : entry,
        ),
      });
      await waitForSolid(() => expect(frame.title).toBe("Refreshed selection portal preview"));
      expect(page.querySelector("iframe")).toBe(frame);

      source.updateSnapshot(
        identity === "client"
          ? { client: createTestGatewayClient(() => replacement.promise) }
          : identity === "account"
            ? { selfUser: { id: "second-user", name: "Second user" } }
            : { hello: { ...hello, auth: { ...hello.auth, recoveryScope: "second-scope" } } },
      );
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();
      replacement.resolve({
        portals: identity === "client" ? initial : [{ ...portal, title: "Replacement app" }],
      });
      await waitForTitle(page, identity === "client" ? "Seeded app" : "Replacement app");
      expect(page.querySelector("iframe")).not.toBe(frame);
    },
  );

  it("retains read access without a method catalog", async () => {
    const source = createContext(null, async () => ({ portals: [] }), ["operator.read"]);
    await mountPage(source.context);
    await waitForRequest(source, "portal.list", {});
  });

  it.each([undefined, "pending-machine"])(
    "drops portal state and stops reads after reconnect without read scope (environment: %s)",
    async (environmentId) => {
      usePollingTimers();
      const methods = ["portal.list", "environments.status"];
      const source = createContext(methods, async () =>
        environmentId ? machine(environmentId) : portalResponse(),
      );
      const page = await mountPage(source.context, undefined, environmentId);
      await waitForSolid(() => expect(source.request).toHaveBeenCalledTimes(1));
      source.updateSnapshot({ phase: "reconnecting" });
      await page.updateComplete;
      expect(page.textContent).not.toContain("This action requires operator.read access.");
      source.updateSnapshot({
        phase: "connected",
        hello: gatewayHelloForMethods(methods, ["operator.sessions.read"]),
      });
      await page.updateComplete;
      source.emitPortals([portal]);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(source.request).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("This action requires operator.read access.");
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).not.toContain("Starting your machine");
    },
  );

  it("shows machine startup before selecting only the portal explicitly opened for its app", async () => {
    usePollingTimers();
    let environment = machine("pending-machine");
    const source = createContext(["environments.status", "portal.list"], async (method) =>
      method === "environments.status" ? environment : portalResponse(),
    );
    const page = await mountPage(source.context, undefined, environment.id);
    await waitForRequest(source, "environments.status", { environmentId: environment.id });
    expect(page.textContent).toContain("Starting your machine");
    expect(page.querySelector("iframe")).toBeNull();
    expect(callsTo(source, "portal.list")).toHaveLength(0);

    environment = { ...environment, status: "available" };
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;
    expect(page.textContent).toContain("Waiting for your application");
    await expectNoPolling(source);
    expect(page.querySelector("iframe")).toBeNull();

    toggle(page, { portalId: portal.id });
    await waitForTitle(page, "Seeded app");
    expect(page.requestedEnvironmentId).toBeNull();
  });

  it("loads only the final environment when native target writes share one turn", async () => {
    const environment = machine("final-machine", "available");
    const source = createContext(["portal.list", "environments.status"], async (method) =>
      method === "portal.list" ? portalResponse() : environment,
    );
    const page = await mountPage(source.context, portal.id);
    await waitForFrame(page);
    source.request.mockClear();

    for (const environmentId of ["intermediate-machine", environment.id]) {
      toggle(page, { environmentId });
    }

    await waitForSolid(() => {
      expect(source.request.mock.calls).toEqual([
        ["environments.status", { environmentId: environment.id }],
      ]);
      expect(page.textContent).toContain("Waiting for your application");
      expect(page.querySelector("iframe")).toBeNull();
    });
  });

  it.each(["success", "failure"] as const)(
    "ignores retired startup %s and preserves current polling",
    async (outcome) => {
      usePollingTimers();
      const retired = createDeferred<EnvironmentSummary>();
      let replacement = machine("new-machine");
      const source = createContext(
        outcome === "success" ? ["environments.status", "portal.list"] : ["environments.status"],
        async (method, params) =>
          method === "portal.list"
            ? portalResponse()
            : params.environmentId === "old-machine"
              ? retired.promise
              : replacement,
      );
      const page = await mountPage(source.context, undefined, "old-machine");
      await updatePage(page, { requestedEnvironmentId: replacement.id });
      await waitForSolid(() => expect(source.request).toHaveBeenCalledTimes(2));
      await source.request.mock.results[1]?.value;
      await waitForSolid(() =>
        expect(source.request).toHaveBeenLastCalledWith("environments.status", {
          environmentId: replacement.id,
        }),
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
      expect(page.querySelector("iframe")).toBeNull();
      page.remove();
      await expectNoPolling(source);
    },
  );

  it("retains the embedded iframe document through custom element presentation changes", async () => {
    let title = portal.title;
    const source = createContext(["portal.list", "ui.command.result"], async (method) =>
      method === "portal.list" ? portalResponse({ ...portal, title }) : { ok: true },
    );
    const page = document.createElement("openclaw-portals-page");
    page.embedded = true;
    page.requestedPortalId = portal.id;
    const provider = createApplicationContextProvider(source.context);
    provider.append(page);
    mountSolid(() => provider);
    await page.updateComplete;
    await waitForFrame(page);
    const frame = frameOf(page)!;
    expect(frame.getAttribute("src")).toBe(portal.url);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
    const writes = vi.spyOn(frame, "setAttribute");
    const sourceWrites = vi.spyOn(frame, "src", "set");

    await updatePage(page, { presented: false });
    expect(page.querySelector("iframe"), "frame after hiding").toBe(frame);
    title = "Refreshed app";
    toggle(page, { portalId: portal.id, requestId: "show-again" });
    await updatePage(page, { presented: true });
    await waitForTitle(page, "Refreshed app");

    expect(page.querySelector("iframe")).toBe(frame);
    expect(writes.mock.calls.filter(([name]) => name === "src")).toEqual([]);
    expect(sourceWrites).not.toHaveBeenCalled();
    expect(probePortalReachable).toHaveBeenCalledTimes(1);
    expectReceipt(source, "show-again", "unverified", "network-reachable");
  });

  it.each(["success", "failure"] as const)(
    "keeps a replacement portal close locked after the old request's %s",
    async (outcome) => {
      const retired = createDeferred<{ closed: boolean }>();
      const current = createDeferred<{ closed: boolean }>();
      const source = actionContext("portal.close", retired.promise);
      const replacement = actionContext("portal.close", current.promise);
      const page = await mountPage(source.context);
      const closeButton = () => page.querySelector<HTMLButtonElement>(".portals-preview__close")!;
      await waitForSolid(() => expect(closeButton()).not.toBeNull());
      closeButton().click();
      await waitForSolid(() => expect(closeButton().disabled).toBe(true));
      source.updateSnapshot({ client: replacement.context.gateway.snapshot.client });
      await waitForSolid(() => expect(closeButton()?.disabled).toBe(false));
      closeButton().click();
      await waitForSolid(() => expect(closeButton().disabled).toBe(true));
      try {
        if (outcome === "success") {
          retired.resolve({ closed: true });
        } else {
          retired.reject(new Error("Retired close failed"));
        }
        await retired.promise.catch(() => undefined);
        await page.updateComplete;
        expect(closeButton().disabled).toBe(true);
        expect(page.textContent).not.toContain("Retired close failed");
        closeButton().click();
        expect(callsTo(replacement, "portal.close")).toHaveLength(1);
      } finally {
        current.resolve({ closed: true });
        await current.promise;
      }
      await waitForSolid(() => expect(closeButton().disabled).toBe(false));
    },
  );

  it("requires write access instead of opening a portal without credentials", async () => {
    const { tokenQuery: _tokenQuery, url: _url, ...redactedPortal } = portal;
    const source = createContext(
      ["portal.list"],
      async () => ({ portals: [redactedPortal as PortalSummary] }),
      ["operator.read"],
    );
    const page = await mountPage(source.context);

    await waitForText(page, "This portal requires an operator with write access.");
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.querySelector(".portals-preview__url")).toBeNull();
    expect(probePortalReachable).not.toHaveBeenCalled();
  });

  it("shows an unreachable notice without mounting the iframe and retries", async () => {
    probePortalReachable.mockResolvedValueOnce("unreachable").mockResolvedValueOnce("reachable");
    const source = actionContext("portal.close", { closed: true });
    const page = await mountPage(source.context);

    await waitForText(page, "Portal not reachable from this browser");
    expect(page.querySelector("iframe")).toBeNull();

    page.querySelector<HTMLButtonElement>(".portals-preview__close")?.click();
    await waitForRequest(source, "portal.close", { id: portal.id });

    const retry = [...page.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry?.click();

    await waitForFrame(page);
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late probe from the previous Gateway", async () => {
    const oldProbe = createDeferred<"reachable">();
    probePortalReachable
      .mockImplementationOnce(() => oldProbe.promise)
      .mockResolvedValueOnce("unreachable");
    const first = createContext(["portal.list"], async () => portalResponse());
    const provider = createSolidApplicationContextProvider(first.context);
    const { container } = mountSolid(() => createComponent(PortalsPage, {}), {
      wrapper: provider.wrapper,
    });
    flush();
    let page = container.querySelector("openclaw-portals-page")!;
    await page.updateComplete;
    await waitForSolid(() => expect(probePortalReachable).toHaveBeenCalledTimes(1));

    const second = createContext(["portal.list"], async () => portalResponse());
    provider.setContext(second.context);
    flush();
    page = container.querySelector("openclaw-portals-page")!;
    await waitForText(page, "Portal not reachable from this browser");
    oldProbe.resolve("reachable");
    await page.updateComplete;
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Portal not reachable from this browser");
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it("shows the empty prompts and an unsupported note without calling the method", async () => {
    const source = createContext([], async () => ({ portals: [] }));
    const page = await mountPage(source.context);

    expect(page.textContent).toContain("Ask the agent to start a portal:");
    expect(page.textContent).toContain("Show me in a portal.");
    expect(page.textContent).toContain("Start the application in a portal.");
    expect(page.textContent).toContain("Make the server available in a portal.");
    expect(page.textContent).toContain("This gateway does not support portals.");
    expect(source.request).not.toHaveBeenCalled();
  });
});

describe("portal presentation receipts", () => {
  it.each([
    ["http://127.0.0.1:43123/", "reachable", "blocked", "remote-ingress-required"],
    ["http://preview.example.test:43123/", "reachable", "new-tab-required", "new-tab-required"],
    ["https://preview.example.test/", "unreachable", "blocked", "network-unreachable"],
    ["https://preview.example.test/", "blocked", "unverified", "probe-blocked"],
  ] as const)(
    "reports presentation for %s / %s as %s (%s) without claiming rendered success",
    async (url, probe, status, reason) => {
      probePortalReachable.mockResolvedValue(probe);
      const source = createContext(["portal.list", "ui.command.result"], async (method) =>
        method === "portal.list"
          ? portalResponse({ ...portal, publicUrl: url, url: url + "?openclaw_portal=synthetic" })
          : { ok: true },
      );
      const page = await mountPage(source.context, portal.id);
      toggle(page, { portalId: portal.id, requestId: "request-one" });
      await waitForSolid(() => expectReceipt(source, "request-one", status, reason));
      expect(callsTo(source, "ui.command.result")).toHaveLength(1);
    },
  );
});
