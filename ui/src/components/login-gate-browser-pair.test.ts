/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "./login-gate-solid.tsx";

vi.mock("../lib/nodes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nodes/index.ts")>()),
  loadOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: "0123456789abcdef",
    publicKey: "public",
    privateKey: "private",
  })),
  signDevicePayload: vi.fn(async () => "signature"),
}));

type GateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<boolean>;
};

const started = { requestId: "request-1", code: "ABCDEFGH", expiresAtMs: Date.now() + 600_000 };
const gatewayUrl = `ws://${window.location.host}`;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(10);
}

async function mountWaitingGate(overrides: Record<string, unknown> = {}) {
  const collect = vi.fn(async () => json({ status: "approved", bootstrapToken: "bootstrap" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url.endsWith("/start") ? json(started) : collect())),
  );
  const onBrowserPaired = vi.fn();
  const onConnect = vi.fn();
  const element = document.createElement("openclaw-login-gate") as GateElement;
  element.props = {
    resourceBasePath: "",
    connected: false,
    lastError: null,
    lastErrorCode: null,
    hasToken: false,
    hasPassword: false,
    gatewayUrl,
    secret: "",
    showGatewaySecret: false,
    onGatewayUrlChange: (value: string) => {
      element.props = { ...element.props, gatewayUrl: value };
    },
    onSecretChange: vi.fn(),
    onBrowserPaired,
    onToggleGatewaySecret: vi.fn(),
    onConnect,
    ...overrides,
  };
  mountSolid(() => element);
  await settle();
  // Hold the first poll so each test decides what happens before an approval arrives.
  const hold = Promise.withResolvers<void>();
  collect.mockImplementationOnce(async () => {
    await hold.promise;
    return json({ status: "approved", bootstrapToken: "bootstrap" });
  });
  element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-start")!.click();
  await settle();
  expect(element.querySelector(".login-gate__browser-pair-code")?.textContent).toBe("ABCD-EFGH");
  return { element, collect, onBrowserPaired, onConnect, approve: hold.resolve };
}

function typeGatewayUrl(element: HTMLElement, value: string) {
  const input = element.querySelector<HTMLInputElement>("#login-gate-url")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("login gate browser pairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the Gateway that issued the approval", async () => {
    const gate = await mountWaitingGate();
    gate.approve();
    await settle();
    expect(gate.onBrowserPaired).toHaveBeenCalledWith("bootstrap", gatewayUrl);
  });

  it("retires a waiting attempt when the Gateway URL is edited", async () => {
    const gate = await mountWaitingGate();
    typeGatewayUrl(gate.element, `${gatewayUrl}/edited`);
    await settle();
    gate.approve();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
    expect(gate.collect).toHaveBeenCalledTimes(1);
    expect(gate.element.querySelector(".login-gate__browser-pair-code")).toBeNull();
  });

  it("retires a waiting attempt when the Gateway target is replaced from outside", async () => {
    const gate = await mountWaitingGate();
    gate.element.props = { ...gate.element.props, gatewayUrl: `${gatewayUrl}/replaced` };
    await settle();
    gate.approve();
    await settle();
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
  });

  it("keeps waiting through refreshed props for the same Gateway", async () => {
    const gate = await mountWaitingGate();
    gate.element.props = { ...gate.element.props, hasToken: true };
    await settle();
    gate.approve();
    await settle();
    expect(gate.onBrowserPaired).toHaveBeenCalledTimes(1);
  });

  it("retires a waiting attempt on a manual connect from the form", async () => {
    const gate = await mountWaitingGate();
    gate.element.querySelector<HTMLButtonElement>(".login-gate__connect")!.click();
    await settle();
    gate.approve();
    await settle();
    expect(gate.onConnect).toHaveBeenCalledTimes(1);
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
  });

  it("retires a waiting attempt on a manual connect from the status view", async () => {
    const gate = await mountWaitingGate({
      lastError: "pairing required",
      lastErrorCode: "PAIRING_REQUIRED",
    });
    expect(gate.element.querySelector('.login-gate__body[data-kind="pairing-required"]')).not.toBe(
      null,
    );
    gate.element.querySelector<HTMLButtonElement>(".login-gate__connect")!.click();
    await settle();
    gate.approve();
    await settle();
    expect(gate.onConnect).toHaveBeenCalledTimes(1);
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
  });

  it("stops polling when the gate is removed", async () => {
    const gate = await mountWaitingGate();
    gate.element.remove();
    await settle();
    gate.approve();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
    expect(gate.collect).toHaveBeenCalledTimes(1);
  });
});
