/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPairSession } from "../lib/browser-pair.ts";
// Preloaded so the gate's lazy card import resolves within one fake-timer settle.
import "./login-gate-browser-pair.tsx";
import { canPairBrowserWithGateway } from "./login-gate-solid.tsx";
import { mountFailure } from "./login-gate.test-support.ts";

vi.mock("../lib/nodes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nodes/index.ts")>()),
  loadOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: "0123456789abcdef",
    publicKey: "public",
    privateKey: "private",
  })),
  signDevicePayload: vi.fn(async () => "signature"),
}));

const started = { requestId: "request-1", code: "ABCDEFGH", expiresAtMs: Date.now() + 600_000 };
const approved = { status: "approved", bootstrapToken: "bootstrap" };
const gatewayUrl = `ws://${window.location.host}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stubReplies(...replies: Response[]) {
  const fetchMock = vi.fn(async () => replies.shift()!);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function session() {
  const handlers = { onState: vi.fn(), onApproved: vi.fn() };
  return { ...handlers, ...createBrowserPairSession({ basePath: "", ...handlers }) };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(10);
}

async function mountWaitingGate(lastError = "", code: string | null = null) {
  const collect = vi.fn(async () => json(approved));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url.endsWith("/start") ? json(started) : collect())),
  );
  const onBrowserPaired = vi.fn();
  const onConnect = vi.fn();
  const element = await mountFailure(lastError, code);
  element.props = {
    ...element.props,
    gatewayUrl,
    onBrowserPaired,
    onConnect,
    onGatewayUrlChange: (value: string) => {
      element.props = { ...element.props, gatewayUrl: value };
    },
  };
  await settle();
  // Hold the first poll so each test decides what happens before an approval arrives.
  const hold = Promise.withResolvers<void>();
  collect.mockImplementationOnce(async () => {
    await hold.promise;
    return json(approved);
  });
  element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-start")!.click();
  await settle();
  // The pairing card holds one way in: the sign-in form waits on the first card.
  expect(element.querySelector("#login-gate-url")).toBeNull();
  element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-get")!.click();
  await settle();
  expect(element.querySelector(".login-gate__browser-pair-code")?.textContent).toContain(
    "ABCD-EFGH",
  );
  return { element, collect, onBrowserPaired, onConnect, approve: hold.resolve };
}

type WaitingGate = Awaited<ReturnType<typeof mountWaitingGate>>;

async function expectRetired(gate: WaitingGate) {
  await settle();
  gate.approve();
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(gate.onBrowserPaired).not.toHaveBeenCalled();
  expect(gate.collect).toHaveBeenCalledTimes(1);
}

describe("browser pairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits through refreshed props, then connects to the issuing Gateway", async () => {
    const gate = await mountWaitingGate();
    gate.element.props = { ...gate.element.props, hasToken: true };
    await settle();
    gate.approve();
    await settle();
    expect(gate.onBrowserPaired).toHaveBeenCalledWith("bootstrap", gatewayUrl);
    // Connection progress and errors show on the sign-in card.
    expect(gate.element.querySelector("#login-gate-url")).not.toBeNull();
  });

  it("retires a waiting attempt when the Gateway target is replaced from outside", async () => {
    const gate = await mountWaitingGate();
    gate.element.props = { ...gate.element.props, gatewayUrl: `${gatewayUrl}/replaced` };
    await expectRetired(gate);
    expect(gate.element.querySelector(".login-gate__browser-pair-code")).toBeNull();
  });

  it.each([
    ["the form", "", null],
    ["the status view", "pairing required", "PAIRING_REQUIRED"],
  ])("goes back to sign-in from pairing opened on %s", async (_, error, code) => {
    const gate = await mountWaitingGate(error, code);
    gate.element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-back")!.click();
    await expectRetired(gate);
    const status = gate.element.querySelector('.login-gate__body[data-kind="pairing-required"]');
    expect(status !== null).toBe(error !== "");
    expect(gate.element.querySelector("#login-gate-url")).not.toBeNull();
  });

  it("stops polling when the gate is removed", async () => {
    const gate = await mountWaitingGate();
    gate.element.remove();
    await expectRetired(gate);
  });

  it("keeps waiting through failed polls, then hands over the approval", async () => {
    const fetchMock = stubReplies(
      json(started),
      json({ status: "pending" }),
      json({ error: "rate_limited" }, 429),
      json(approved),
    );
    const pair = session();
    await pair.start("ws://gateway.example");
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "waiting",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(4_100);
    expect(pair.onApproved).toHaveBeenCalledWith("bootstrap", "ws://gateway.example");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{ status: "rejected" }, 200, "declined"],
    [{ status: "expired" }, 200, "expired"],
    [{ error: "not_found" }, 404, "expired"],
  ])("stops on a final answer %j", async (body, status, reason) => {
    stubReplies(json(started), json(body, status));
    const pair = session();
    await pair.start("ws://gateway.example");
    await settle();
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "failed", reason });
  });

  it("stops polling once cancelled", async () => {
    const fetchMock = stubReplies(json(started), json({ status: "pending" }));
    const pair = session();
    await pair.start("ws://gateway.example");
    await settle();
    pair.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "idle" });
  });

  it("names a full Gateway separately from a broken one", async () => {
    stubReplies(json({ error: "capacity" }, 429));
    const pair = session();
    await pair.start("ws://gateway.example");
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "failed", reason: "busy" });
  });

  it("waits past the start deadline for the Gateway's answer", async () => {
    // Approval extends the request on the Gateway; a suspended tab wakes up after the
    // deadline it was first given and must still collect.
    const fetchMock = stubReplies(
      json({ ...started, expiresAtMs: Date.now() + 1_000 }),
      json({ status: "pending" }),
      json(approved),
    );
    const pair = session();
    await pair.start("ws://gateway.example");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pair.onApproved).toHaveBeenCalledWith("bootstrap", "ws://gateway.example");
  });

  it("offers pairing only for the Gateway serving this page", () => {
    expect(canPairBrowserWithGateway(gatewayUrl, "")).toBe(true);
    expect(canPairBrowserWithGateway(`${gatewayUrl}/team/`, "/team")).toBe(true);
    // Same host, different mount: another Gateway issues the approval.
    expect(canPairBrowserWithGateway(`${gatewayUrl}/other`, "/team")).toBe(false);
    expect(canPairBrowserWithGateway(gatewayUrl, "/team")).toBe(false);
    expect(canPairBrowserWithGateway("wss://other.example", "")).toBe(false);
    expect(canPairBrowserWithGateway("", "")).toBe(false);
  });
});
