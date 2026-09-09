import type { HumanInterventionResponse, HumanInterventionState } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  resolveHumanBrowserPoint,
  type OpenClawHumanInterventionPanel,
} from "./human-intervention-panel.ts";

class TestSocket extends EventTarget {
  binaryType = "";
  close = vi.fn();
}

function screencastFrame(url: string): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({ url, cssWidth: 1000, cssHeight: 800 }));
  const packet = new Uint8Array(4 + header.byteLength + 1);
  new DataView(packet.buffer).setUint32(0, header.byteLength);
  packet.set(header, 4);
  return packet.buffer;
}

function handoff(
  state: HumanInterventionState = "waiting",
  generation = 1,
): HumanInterventionResponse {
  return {
    handoff: {
      id: "handoff-1",
      state,
      generation,
      reason: "Complete the verification challenge",
      hostname: "accounts.example",
      expiresAtMs: Date.now() + 60_000,
      browser: { target: "host", profile: "openclaw", targetId: "tab-1" },
    },
  };
}

function stubWebSockets() {
  const sockets: TestSocket[] = [];
  const createSocket = vi.fn(function () {
    const socket = new TestSocket();
    sockets.push(socket);
    return socket;
  });
  vi.stubGlobal("WebSocket", createSocket);
  return { sockets, createSocket };
}

function createClient() {
  const request = vi.fn(
    async (
      method: string,
    ): Promise<HumanInterventionResponse | { wsPath: string } | { ok: true }> => {
      if (method === "browser.handoff.get") {
        return handoff();
      }
      if (method === "browser.handoff.claim") {
        return handoff("control", 2);
      }
      if (method === "browser.handoff.browser") {
        return { wsPath: "/browser/stream" };
      }
      if (method === "browser.handoff.complete") {
        return handoff("resumed", 3);
      }
      return handoff("control", 2);
    },
  );
  return {
    request,
    client: { request, gatewayUrl: "ws://gateway.test" } as unknown as GatewayBrowserClient,
  };
}

async function mountPanel(client: GatewayBrowserClient) {
  const panel = document.createElement(
    "openclaw-human-intervention-panel",
  ) as OpenClawHumanInterventionPanel;
  panel.client = client;
  panel.available = true;
  panel.handoffId = "handoff-1";
  document.body.append(panel);
  await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("accounts.example"));
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("human browser intervention panel", () => {
  it.each([
    ["resume_pending", "waiting to be queued"],
    ["resumed", "queued to continue"],
  ] as const)("reports %s without claiming that execution has started", async (state, message) => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce(handoff(state, 3));
    const panel = await mountPanel(client);
    expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(message);
  });

  it("does not acquire local control when another device rejects the claim", async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce(handoff("control", 2));
    const panel = await mountPanel(client);
    request.mockRejectedValueOnce(new Error("controlled elsewhere"));
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.textContent).toContain("controlled elsewhere"),
    );
    expect(panel.shadowRoot?.querySelector("[data-complete]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.leave")).toBe(false);
  });

  it("discards a stream ticket that arrives after the panel disconnects", async () => {
    const { createSocket: socketConstructor } = stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    request.mockResolvedValueOnce(handoff("control", 2));
    let resolveTicket!: (value: { wsPath: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() => expect(resolveTicket).toBeTypeOf("function"));
    panel.remove();
    resolveTicket({ wsPath: "/browser/stream" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(socketConstructor).not.toHaveBeenCalled();
  });

  it("reloads status when the authenticated client changes at the same URL", async () => {
    const first = createClient();
    const panel = await mountPanel(first.client);
    const second = createClient();
    panel.client = second.client;
    await waitForFast(() =>
      expect(second.request).toHaveBeenCalledWith("browser.handoff.get", { id: "handoff-1" }),
    );
  });

  it("ignores a renewal response after completion retires control", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    let resolveRenewal!: (value: HumanInterventionResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRenewal = resolve;
        }),
    );
    const renew = intervals.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    expect(renew).toBeTypeOf("function");
    if (typeof renew === "function") {
      renew();
    }
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("return to your chat"));
    resolveRenewal(handoff("control", 2));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(panel.shadowRoot?.textContent).toContain("return to your chat");
    expect(panel.shadowRoot?.querySelector("[data-complete]")).toBeNull();
  });

  it("uses a new controller identity after the authenticated connection changes", async () => {
    stubWebSockets();
    const first = createClient();
    const panel = await mountPanel(first.client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    const second = createClient();
    panel.client = second.client;
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-take-control]")).not.toBeNull(),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    const firstClaim = first.request.mock.calls.find(
      ([method]) => method === "browser.handoff.claim",
    );
    const secondClaim = second.request.mock.calls.find(
      ([method]) => method === "browser.handoff.claim",
    );
    expect(firstClaim).toBeDefined();
    expect(secondClaim).toBeDefined();
    expect(secondClaim).not.toEqual(firstClaim);
  });

  it("maps displayed image coordinates to the unchanged remote viewport", () => {
    expect(
      resolveHumanBrowserPoint(
        { clientX: 260, clientY: 220 },
        { left: 10, top: 20, width: 500, height: 400 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 500, y: 400 });
  });

  it("claims the exact handoff, opens its scoped stream, and completes with the lease fence", async () => {
    const { sockets } = stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);

    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.browser", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
        operation: "screencast",
        maxWidth: 2000,
        maxHeight: 2000,
      }),
    );
    expect(sockets).toHaveLength(1);
    expect(panel.shadowRoot?.querySelector<HTMLInputElement>(".text-entry input")?.disabled).toBe(
      true,
    );

    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.complete", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("return to your chat"));
  });

  it("leaves control without resuming the paused agent", async () => {
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("You have control"));

    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-leave]")?.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.leave", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
      false,
    );
  });

  it("renews control while the browser stream remains open", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "browser.handoff.browser")).toBe(
        true,
      ),
    );
    const renewalCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 30_000);
    const renewalTimer = setIntervalSpy.mock.results.at(-1)?.value;

    expect(clearIntervalSpy).not.toHaveBeenCalledWith(renewalTimer);
    expect(renewalCall).toBeDefined();
    const renew = renewalCall?.[0];
    if (typeof renew === "function") {
      renew();
    }

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.renew", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
  });

  it("keeps completion disabled until remote input finishes", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:frame");
        static override revokeObjectURL = vi.fn();
      },
    );
    const { sockets } = stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() => expect(sockets).toHaveLength(1));
    sockets[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ready",
          targetId: "tab-1",
          url: "https://accounts.example/challenge",
          title: "Challenge",
        }),
      }),
    );
    sockets[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: screencastFrame("https://accounts.example/challenge"),
      }),
    );
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector<HTMLInputElement>(".text-entry input")?.disabled).toBe(
        false,
      ),
    );

    let releaseInput: (() => void) | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "browser.handoff.browser") {
        await new Promise<void>((resolve) => {
          releaseInput = resolve;
        });
        return { ok: true };
      }
      if (method === "browser.handoff.complete") {
        return handoff("resumed", 3);
      }
      return handoff("control", 2);
    });

    const scrollDown = [
      ...(panel.shadowRoot?.querySelectorAll<HTMLButtonElement>(".toolbar button") ?? []),
    ].find((button) => button.textContent?.includes("Scroll down"));
    scrollDown?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.disabled).toBe(
        true,
      ),
    );
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
      false,
    );

    releaseInput?.();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.disabled).toBe(
        false,
      ),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
        true,
      ),
    );
  });

  it("retries a transient handoff lookup failure", async () => {
    const { client, request } = createClient();
    request.mockRejectedValueOnce(new Error("Gateway is offline"));
    const panel = document.createElement(
      "openclaw-human-intervention-panel",
    ) as OpenClawHumanInterventionPanel;
    panel.client = client;
    panel.available = true;
    panel.handoffId = "handoff-1";
    document.body.append(panel);

    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("Gateway is offline"));
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-retry]")?.click();

    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("accounts.example"));
    expect(request).toHaveBeenCalledTimes(2);
  });
});
