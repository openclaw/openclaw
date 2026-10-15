/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
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
import "../debug/debug-overlay-content.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DebugOverlayElement } from "../debug/debug-overlay-state.ts";
import { ConnectionPage } from "./connection-page.tsx";
import "../debug/debug-overlay.ts";
const mounts: Array<() => void> = [];

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
    degradedSinceMs: null,
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

function source(
  client: GatewayBrowserClient,
  pingRequest: (...args: Parameters<GatewayBrowserClient["request"]>) => Promise<unknown> = vi
    .fn()
    .mockResolvedValue(null),
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

async function mount(gateway: ApplicationGateway, { attached = true } = {}) {
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
  mounts.push(unmount);
  await waitForPage(() =>
    expect(provider.querySelector("openclaw-connection-page")).not.toBeNull(),
  );
  return {
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

function control(page: HTMLElement, selector: string) {
  const element = page.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
  if (!element) {
    throw new Error(`Missing Connection control: ${selector}`);
  }
  return element;
}

afterEach(async () => {
  mounts.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  await Promise.resolve();
  flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ConnectionPage browser sign-in", () => {
  it.each([
    { phase: "offline", stale: false },
    { phase: "stopped", stale: false },
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
      const forget = () =>
        [...page.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Forget this browser",
        );
      expect(forget()).toBeDefined();
      forget()?.click();
      await waitForPage(() =>
        expect(document.querySelector(".exec-approval-actions button.danger")).not.toBeNull(),
      );
      document
        .querySelector<HTMLButtonElement>(".exec-approval-actions button:not(.danger)")
        ?.click();
      await waitForPage(() => expect(document.querySelector(".exec-approval-actions")).toBeNull());
      expect(gateway.forgetDeviceToken).not.toHaveBeenCalled();
      forget()?.click();
      await waitForPage(() =>
        expect(document.querySelector(".exec-approval-actions button.danger")).not.toBeNull(),
      );
      expect(document.querySelector(".exec-approval-sub")?.textContent).toContain(
        "gateway.example.test",
      );
      if (stale) {
        gateway.connection.gatewayUrl = "wss://other.example.test";
      }
      document.querySelector<HTMLButtonElement>(".exec-approval-actions button.danger")?.click();
      if (stale) {
        await waitForPage(() =>
          expect(document.querySelector(".exec-approval-actions")).toBeNull(),
        );
        expect(gateway.forgetDeviceToken).not.toHaveBeenCalled();
        return;
      }
      await waitForPage(() => expect(gateway.forgetDeviceToken).toHaveBeenCalledOnce());
      await waitForPage(() => {
        expect(forget()).toBeUndefined();
      });
    },
  );
});

describe("ConnectionPage ping", () => {
  it("starts diagnostics for a bound lazy route before insertion and stops at disposal", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn().mockResolvedValue(gatewaySystemInfo);
    const current = source({ request } as unknown as GatewayBrowserClient);
    const { provider, unmount } = await mount(current.gateway, { attached: false });
    expect(provider.isConnected).toBe(false);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["system.info"]);
    document.body.append(provider);
    flush();
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shares six status reads per minute with a tray mounted between page polls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const request = vi.fn().mockResolvedValue(gatewaySystemInfo);
    const current = source({ request } as unknown as GatewayBrowserClient);
    Object.assign(current.gateway, {
      eventLog: [],
      subscribeEventLog: () => () => undefined,
    });
    const { provider, unmount } = await mount(current.gateway);
    const statusReads = () => request.mock.calls.filter(([method]) => method === "system.info");
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

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusReads()).toHaveLength(7);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toHaveLength(8);
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusReads()).toHaveLength(8);
  });

  function pingStat(page: HTMLElement, label: string) {
    const term = [...page.querySelectorAll(".connection-ping__stats dt")].find(
      (element) => element.textContent?.trim() === label,
    );
    return term?.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim();
  }

  function pingClient() {
    return {
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient;
  }

  it("shows average and nearest-rank percentiles for the last 100 successful round trips", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const durations = [9_999, ...Array.from({ length: 100 }, (_, index) => 100 - index)];
    const pingRequest = vi.fn().mockImplementation(async () => {
      now += durations.shift()!;
      return null;
    });
    const { page } = await mount(source(pingClient(), pingRequest).gateway);
    await waitForPage(() => expect(pingStat(page, "Avg ping")).toBe("9999.0 ms"));

    await vi.advanceTimersByTimeAsync(1_000_000);
    await waitForPage(() => {
      expect(pingRequest).toHaveBeenCalledTimes(101);
      expect(pingStat(page, "Avg ping")).toBe("50.5 ms");
      expect(pingStat(page, "p50")).toBe("50.0 ms");
      expect(pingStat(page, "p95")).toBe("95.0 ms");
      expect(pingStat(page, "p99")).toBe("99.0 ms");
      expect(page.querySelector(".connection-ping")?.textContent).toContain("Samples: 100/100");
    });
  });

  it("keeps one ping in flight, excludes failures and hidden responses, and cancels on exit", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const responses = Array.from({ length: 5 }, () => deferred<null>());
    let nextResponse = 0;
    const pingRequest = vi.fn().mockImplementation(() => responses[nextResponse++]!.promise);
    const { page, unmount } = await mount(source(pingClient(), pingRequest).gateway);
    expect(page.querySelector(".connection-ping")?.textContent).toContain("Measuring ping…");
    now = 20;
    responses[0]!.resolve(null);
    await waitForPage(() => {
      expect(pingStat(page, "Avg ping")).toBe("20.0 ms");
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(pingRequest).toHaveBeenCalledTimes(2);
    expect(pingRequest.mock.calls[1]?.[2]).toEqual({
      timeoutMs: 10_000,
      signal: expect.any(AbortSignal),
    });
    responses[1]!.reject(new Error("Gateway request timed out"));
    await waitForPage(() => {
      expect(page.querySelector(".connection-ping")?.textContent).toContain("Last ping failed.");
      expect(pingStat(page, "Avg ping")).toBe("20.0 ms");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pingRequest).toHaveBeenCalledTimes(3);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pingRequest.mock.calls[2]?.[2].signal.aborted).toBe(true);
    now = 10_000;
    responses[2]!.resolve(null);
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForPage(() => {
      expect(pingRequest).toHaveBeenCalledTimes(3);
      expect(page.querySelector(".connection-ping")?.textContent).toContain("Samples: 1/100");
    });

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    now += 40;
    responses[3]!.resolve(null);
    await waitForPage(() => {
      expect(pingStat(page, "Avg ping")).toBe("30.0 ms");
      expect(page.querySelector(".connection-ping")?.textContent).not.toContain(
        "Last ping failed.",
      );
    });
    await vi.advanceTimersByTimeAsync(10_000);
    unmount();
    expect(pingRequest.mock.calls[4]?.[2].signal.aborted).toBe(true);
    responses[4]!.resolve(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pingRequest).toHaveBeenCalledTimes(5);
  });

  it.each(["reconnect", "source", "client"] as const)(
    "clears samples and rejects late replies after a %s change",
    async (change) => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
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
          now += 20;
          return null;
        })
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(fresh.promise);
      const client = { request: systemInfoRequest } as unknown as GatewayBrowserClient;
      const first = source(client, pingRequest);
      const { page, context, setContext } = await mount(first.gateway);
      await waitForPage(() => expect(pingStat(page, "Avg ping")).toBe("20.0 ms"));
      const activity = () => page.querySelector(".connection-activity")?.textContent;
      await waitForPage(() => expect(activity()).toContain("432 MB"));
      await vi.advanceTimersByTimeAsync(10_000);

      if (change === "reconnect") {
        first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
        await waitForPage(() => {
          expect(page.querySelector(".connection-ping")).toBeNull();
        });
        first.publish({
          ...first.gateway.snapshot,
          phase: "connected",
          hello: gatewayHelloForMethods(["system.info"]),
        });
      } else if (change === "source") {
        setContext({
          ...context,
          gateway: source(client, pingRequest).gateway,
        });
      } else {
        first.publish({
          ...first.gateway.snapshot,
          client: source(
            { request: systemInfoRequest } as unknown as GatewayBrowserClient,
            pingRequest,
          ).gateway.snapshot.client,
        });
      }
      await waitForPage(() => {
        expect(pingRequest.mock.calls[1]?.[2].signal.aborted).toBe(true);
        expect(systemInfoRequest.mock.calls[1]?.[2].signal.aborted).toBe(true);
      });
      now += 500;
      stale.resolve(null);
      staleStatus.resolve(gatewaySystemInfo);
      await waitForPage(() => {
        expect(pingStat(page, "Avg ping")).toBe("—");
        expect(activity()).not.toContain("432 MB");
        expect(page.querySelector(".connection-ping")?.textContent).toContain("Measuring ping…");
      });
      now += 10;
      fresh.resolve(null);
      freshStatus.resolve({
        ...deviceSystemInfo,
        eventLoop: { ...gatewayActivity.eventLoop, cpuCoreRatio: 0.7, delayP99Ms: 5 },
      });
      await waitForPage(() => {
        expect(pingStat(page, "Avg ping")).toBe("510.0 ms");
        expect(page.querySelector(".connection-ping")?.textContent).toContain("Samples: 1/100");
        expect(activity()).toContain("70%");
      });
    },
  );

  it("shares one host and activity poll independently of ping and reports failed refreshes", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const initial = deferred<SystemInfoResult>();
    const next = deferred<SystemInfoResult>();
    const systemInfoRequest = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(next.promise)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(gatewaySystemInfo);
    const { page, unmount } = await mount(
      source({ request: systemInfoRequest } as unknown as GatewayBrowserClient).gateway,
    );
    const host = () => page.querySelector("#settings-connection-host");
    const placeholders = () => host()?.querySelectorAll('.skeleton[aria-hidden="true"]');
    expect(placeholders()?.length).toBeGreaterThan(0);
    expect(host()?.textContent).not.toContain("Loading…");
    expect(host()?.getAttribute("aria-busy")).toBe("true");
    initial.resolve(gatewaySystemInfo);
    await waitForPage(() => {
      expect(placeholders()).toHaveLength(0);
      expect(host()?.getAttribute("aria-busy")).toBe("false");
      expect(host()?.textContent).toContain("Gateway");
    });
    const loadedHostText = host()?.textContent;
    const activity = () => page.querySelector(".connection-activity");
    expect(activity()?.textContent).toContain("432 MB");
    expect(activity()?.textContent).toContain("42%");
    expect(systemInfoRequest.mock.calls.map(([method]) => method)).toEqual(["system.info"]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(systemInfoRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForPage(() => {
      expect(placeholders()).toHaveLength(0);
      expect(host()?.textContent).toBe(loadedHostText);
      expect(host()?.getAttribute("aria-busy")).toBe("true");
      expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Gateway");
      expect(page.querySelectorAll('[role="meter"]').length).toBeGreaterThan(0);
      expect(systemInfoRequest.mock.calls.map(([method]) => method)).toEqual([
        "system.info",
        "system.info",
      ]);
    });
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
    await waitForPage(() => {
      expect(activity()?.textContent).toContain("60%");
      expect(page.querySelector(".config-host__name")?.textContent).toContain("Fresh host");
      expect(activity()?.querySelectorAll("polyline")).toHaveLength(3);
      expect(activity()?.querySelector(".gateway-vital--cpu")?.hasAttribute("data-degraded")).toBe(
        true,
      );
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForPage(() => {
      expect(activity()?.textContent).toContain("Activity refresh failed.");
      expect(placeholders()).toHaveLength(0);
      expect(host()?.getAttribute("aria-busy")).toBe("false");
      expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Fresh host");
      expect(activity()?.textContent).toContain("60%");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForPage(() => {
      expect(activity()?.textContent).not.toContain("Activity refresh failed.");
    });
    const hidden = deferred<SystemInfoResult>();
    systemInfoRequest.mockReturnValueOnce(hidden.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(systemInfoRequest.mock.calls[4]?.[2].signal.aborted).toBe(true);
    hidden.resolve({ ...gatewaySystemInfo, machineName: "Hidden stale host" });
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForPage(() => {
      expect(systemInfoRequest).toHaveBeenCalledTimes(5);
      expect(page.querySelector(".config-host__name")?.textContent).not.toContain(
        "Hidden stale host",
      );
    });
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForPage(() => {
      expect(systemInfoRequest).toHaveBeenCalledTimes(6);
    });
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(systemInfoRequest).toHaveBeenCalledTimes(6);
  });
});

function editInput(page: HTMLElement, label: string, value: string) {
  const input = control(page, `input[aria-label="${label}"]`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConnectionPage credentials", () => {
  it.each([
    {
      token: "saved-token",
      password: "saved-password",
      displayed: "saved-token",
      change: "secret",
    },
    { token: "", password: "injected-password", displayed: "injected-password", change: "secret" },
    { token: "old-token", password: "old-password", displayed: "old-token", change: "url" },
  ])(
    "replaces credentials without retaining a hidden secret: $displayed, $change",
    async ({ token, password, displayed, change }) => {
      const current = source({
        request: vi.fn().mockResolvedValue(deviceSystemInfo),
      } as unknown as GatewayBrowserClient);
      Object.assign(current.gateway.connection, {
        gatewayUrl: "wss://gateway.example/openclaw",
        token,
        password,
      });
      const connect = vi.spyOn(current.gateway, "connect");
      const { page } = await mount(current.gateway);
      const secret = () => control(page, 'input[aria-label="Gateway secret"]');
      expect(page.querySelectorAll(".settings-secret input")).toHaveLength(1);
      expect(secret().value).toBe(displayed);
      expect(page.querySelector('[role="radiogroup"]')).toBeNull();
      control(page, ".connection-details button").click();
      expect(connect).toHaveBeenLastCalledWith();
      if (change === "url") {
        editInput(page, "Gateway URL", "wss://other-gateway.example/openclaw");
        await waitForPage(() => {
          expect(secret().value).toBe("");
        });
      } else {
        editInput(page, "Gateway secret", "");
        await waitForPage(() => {
          expect(secret().value).toBe("");
        });
        editInput(page, "Gateway secret", "edited-secret");
        flush();
      }
      control(page, "button.btn.primary").click();
      expect(connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          gatewayUrl:
            change === "url"
              ? "wss://other-gateway.example/openclaw"
              : "wss://gateway.example/openclaw",
          token: change === "url" ? "" : "edited-secret",
          password: "",
        }),
      );
    },
  );

  it("offers connection actions only while the draft differs", async () => {
    const current = source({
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient);
    const { page } = await mount(current.gateway);
    const actions = () =>
      [...page.querySelectorAll<HTMLButtonElement>(".settings-group button")].filter((button) =>
        ["Connect", "Apply and reconnect", "Discard changes"].includes(
          button.textContent?.trim() ?? "",
        ),
      );
    const labels = () => actions().map((button) => button.textContent?.trim());
    expect(labels()).toEqual([]);
    editInput(page, "Gateway secret", "draft-token");
    await waitForPage(() => {
      expect(labels()).toEqual(["Discard changes", "Apply and reconnect"]);
    });
    editInput(page, "Gateway secret", "");
    await waitForPage(() => {
      expect(labels()).toEqual([]);
    });
    editInput(page, "Gateway secret", "draft-token");
    flush();
    control(page, ".connection-actions button").click();
    await waitForPage(() => {
      expect(control(page, 'input[aria-label="Gateway secret"]').value).toBe("");
      expect(labels()).toEqual([]);
    });
  });
});

describe("ConnectionPage session selection", () => {
  it("saves and discards session edits independently of the pending connection", async () => {
    const current = source({
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient);
    const connect = vi.spyOn(current.gateway, "connect");
    current.gateway.setSessionKey = vi.fn((sessionKey) => {
      current.publish({ ...current.gateway.snapshot, sessionKey: sessionKey.trim() });
    });
    const { page } = await mount(current.gateway);
    const sessionSection = control(page, 'input[aria-label="Default session"]').closest(
      ".settings-section",
    );
    if (!sessionSection) {
      throw new Error("Missing Session section");
    }
    const button = (name: string) => {
      const found = [...sessionSection.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === name,
      );
      if (!found) {
        throw new Error(`Missing session action: ${name}`);
      }
      return found;
    };
    editInput(page, "Gateway secret", "pending-token");
    editInput(page, "Default session", "main-other");
    flush();
    editInput(page, "Default session", "main");
    await waitForPage(() => {
      expect(sessionSection.querySelector("button")).toBeNull();
    });
    editInput(page, "Default session", "  saved-session  ");
    flush();
    button("Save").click();
    await waitForPage(() => {
      expect(current.gateway.snapshot.sessionKey).toBe("saved-session");
      expect(control(page, 'input[aria-label="Default session"]').value).toBe("saved-session");
      expect(control(page, 'input[aria-label="Gateway secret"]').value).toBe("pending-token");
      expect(page.textContent).toContain("Saved");
      expect(connect).not.toHaveBeenCalled();
    });
    editInput(page, "Default session", " ");
    await waitForPage(() => {
      expect(button("Save").disabled).toBe(true);
    });
    button("Discard changes").click();
    await waitForPage(() => {
      expect(control(page, 'input[aria-label="Default session"]').value).toBe("saved-session");
    });
  });
});

describe("ConnectionPage Gateway lifecycle", () => {
  it("keeps an edited draft through reconnect and resets it for a replacement source", async () => {
    const request = vi.fn().mockResolvedValue(deviceSystemInfo);
    const client = { request } as unknown as GatewayBrowserClient;
    const first = source(client);
    const { page, context, setContext } = await mount(first.gateway);
    const input = (label: string) => control(page, `input[aria-label="${label}"]`);
    editInput(page, "Gateway secret", "draft-secret");
    editInput(page, "Default session", "draft-session");
    control(page, 'button[aria-label="Toggle secret visibility"]').click();
    await waitForPage(() => {
      expect(input("Gateway secret").type).toBe("text");
    });

    first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
    await waitForPage(() => {
      expect(input("Gateway secret").type).toBe("password");
      expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("—");
    });
    first.publish({
      ...first.gateway.snapshot,
      phase: "connected",
      sessionKey: "remote-session",
      hello: gatewayHelloForMethods(["system.info"]),
    });
    await waitForPage(() => {
      expect(input("Gateway secret").value).toBe("draft-secret");
      expect(input("Default session").value).toBe("draft-session");
      expect(input("Gateway secret").type).toBe("password");
      expect(request).toHaveBeenCalledTimes(2);
    });

    const second = source(client);
    Object.assign(second.gateway.connection, {
      token: "replacement-token",
      password: "replacement-password",
    });
    setContext({ ...context, gateway: second.gateway });
    await waitForPage(() => {
      expect(input("Gateway secret").value).toBe("replacement-token");
      expect(input("Default session").value).toBe("main");
      expect(input("Gateway secret").type).toBe("password");
      expect(request).toHaveBeenCalledTimes(3);
    });
  });

  it.each(["response", "error", "response before rebinding"] as const)(
    "rejects an old Gateway source %s when the replacement reuses its client",
    async (outcome) => {
      vi.useFakeTimers();
      const firstResponse = deferred<SystemInfoResult>();
      const secondResponse = deferred<SystemInfoResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(secondResponse.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const first = source(client);
      const second = source(client);
      const { page, context, setContext } = await mount(first.gateway);
      if (outcome === "response before rebinding") {
        // Queue completion before the replacement context retires the old consumer tree.
        firstResponse.resolve({ ...deviceSystemInfo, machineName: "Stale" });
      }
      setContext({ ...context, gateway: second.gateway });
      await waitForPage(() => {
        expect(request).toHaveBeenCalledTimes(2);
      });

      if (outcome === "response") {
        firstResponse.resolve({ ...deviceSystemInfo, machineName: "Stale" });
      } else if (outcome === "error") {
        firstResponse.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "unknown method: system.info",
          }),
        );
      }
      await waitForPage(() => {
        expect(page.querySelector(".config-host__name .skeleton")).not.toBeNull();
        expect(page.querySelector(".config-host__name")?.textContent).not.toContain("Stale");
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request).toHaveBeenCalledTimes(2);

      secondResponse.resolve({ ...deviceSystemInfo, machineName: "Current" });
      await waitForPage(() => {
        expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Current");
      });
    },
  );

  it.each([
    ["transient", new Error("temporarily unavailable"), true],
    [
      "missing read scope",
      new GatewayRequestError({
        code: "FORBIDDEN",
        message: "permission denied",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      }),
      false,
    ],
  ] as const)("preserves the polling policy after a %s error", async (_kind, error, retry) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(deviceSystemInfo)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(deviceSystemInfo);
    const { page } = await mount(source({ request } as unknown as GatewayBrowserClient).gateway);
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForPage(() => {
      expect(page.querySelector(".config-host__name")?.textContent?.trim() ?? null).toBe(
        retry ? "Gateway" : null,
      );
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(retry ? 3 : 2);
  });

  it.each(["advertisement", "scope"] as const)(
    "retires a pending host read when its %s disappears",
    async (change) => {
      const response = deferred<SystemInfoResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(response.promise)
        .mockResolvedValue(deviceSystemInfo);
      const current = source({ request } as unknown as GatewayBrowserClient);
      const { page } = await mount(current.gateway);
      current.publish({
        ...current.gateway.snapshot,
        hello: gatewayHelloForMethods(
          change === "advertisement" ? [] : ["system.info"],
          change === "scope" ? ["operator.sessions.read"] : ["operator.admin"],
        ),
      });
      response.resolve(deviceSystemInfo);
      await waitForPage(() => {
        expect(page.querySelector(".config-host__name")).toBeNull();
      });
      current.publish({
        ...current.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info"]),
      });
      await waitForPage(() => {
        expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Gateway");
        expect(request).toHaveBeenCalledTimes(2);
      });
    },
  );
});
