/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectBrowserGatewayConnectAuth } from "../api/gateway-connect-plan.ts";
import { createBrowserPairSession } from "../lib/browser-pair.ts";
import { loadDeviceAuthToken } from "../lib/nodes/index.ts";
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
const approved = {
  status: "approved",
  deviceToken: "device-token",
  role: "operator",
  scopes: ["operator.admin", "operator.read"],
};

function storedToken(url: string) {
  return loadDeviceAuthToken({ deviceId: "0123456789abcdef", gatewayUrl: url, role: "operator" });
}
const gatewayUrl = `ws://${window.location.host}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stubReplies(...replies: (Response | Error)[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift();
    if (!reply || reply instanceof Error) {
      throw reply ?? new Error("Unexpected browser pairing request");
    }
    return reply;
  });
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
    expect(gate.onBrowserPaired).toHaveBeenCalledWith(gatewayUrl);
    expect(storedToken(gatewayUrl)).toMatchObject({ token: "device-token" });
    // Connection progress and errors show on the sign-in card.
    expect(gate.element.querySelector("#login-gate-url")).not.toBeNull();
  });

  it("hides direct pairing on remote ingress and embedded ID transport", () => {
    document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
    try {
      expect(canPairBrowserWithGateway(gatewayUrl, "")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-openclaw-remote-ingress");
    }
    document.documentElement.setAttribute("data-openclaw-id-enabled", "true");
    document.documentElement.setAttribute("data-openclaw-control-ui-base-path", "");
    vi.stubGlobal("__openclawTransport", {});
    try {
      expect(canPairBrowserWithGateway(gatewayUrl, "")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-openclaw-id-enabled");
      document.documentElement.removeAttribute("data-openclaw-control-ui-base-path");
    }
  });

  it("explains administrator pairing on the Gateway host", async () => {
    const gate = await mountWaitingGate();
    expect(gate.element.textContent).toContain("Run on the Gateway host");
    expect(gate.element.textContent).toContain("administrator access");
    expect(gate.element.textContent).toContain("not a guest invitation");
  });

  it("shows reconnecting until a pending reply restores waiting without a new request", async () => {
    const fetchMock = stubReplies(
      json(started),
      new Error("offline"),
      json({ status: "pending" }),
      json(approved),
    );
    const pair = session();
    await pair.start(gatewayUrl);
    await settle();
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "reconnecting",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "waiting",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(pair.onApproved).toHaveBeenCalledWith(gatewayUrl);
    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)),
    }));
    expect(requests.filter(({ url }) => String(url).endsWith("/start"))).toHaveLength(1);
    expect(requests.slice(1).every(({ body }) => body.requestId === "request-1")).toBe(true);
    pair.dispose();
  });

  it("times out a stalled fetch and resumes the same request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(json(approved));
    vi.stubGlobal("fetch", fetchMock);
    const pair = session();
    await pair.start(gatewayUrl);
    await settle();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "reconnecting",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(pair.onApproved).toHaveBeenCalledWith(gatewayUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pair.dispose();
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
    expect(pair.onApproved).toHaveBeenCalledWith("ws://gateway.example");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The issuing Gateway's paired token is what the next connect selects.
    expect(storedToken("ws://gateway.example")).toMatchObject({
      token: "device-token",
      scopes: expect.arrayContaining(["operator.admin", "operator.read"]),
    });
    // Same-origin cookies go along, so an auth proxy in front of the Gateway admits the route.
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.credentials).toBe("same-origin");
    }
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

  it("awaits signed withdrawal and ignores a late collect approval", async () => {
    const collect = Promise.withResolvers<Response>();
    const withdrawal = Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockReturnValueOnce(collect.promise)
      .mockReturnValueOnce(withdrawal.promise);
    vi.stubGlobal("fetch", fetchMock);
    const pair = session();
    await pair.start(gatewayUrl);
    await settle();
    const cancelling = pair.cancel();
    await settle();
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "cancelling",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    const cancellationRequest = fetchMock.mock.calls[2];
    if (!cancellationRequest) {
      throw new Error("Cancel did not send a withdrawal request");
    }
    const [url, init] = cancellationRequest;
    expect(url).toBe("/__openclaw__/browser-pair/cancel");
    expect(JSON.parse(String(init.body))).toMatchObject({
      requestId: "request-1",
      deviceId: "0123456789abcdef",
      publicKey: "public",
      signature: "signature",
    });
    collect.resolve(json(approved));
    await settle();
    expect(pair.onApproved).not.toHaveBeenCalled();
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "cancelling",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    withdrawal.resolve(json({ status: "cancelled" }));
    await cancelling;
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed withdrawal visible and retries the same request", async () => {
    const fetchMock = stubReplies(
      json(started),
      json({ status: "pending" }),
      new Error("offline"),
      json({ status: "cancelled" }),
    );
    const pair = session();
    await pair.start(gatewayUrl);
    await settle();
    await pair.cancel();
    expect(pair.onState).toHaveBeenLastCalledWith({
      kind: "cancelFailed",
      code: "ABCD-EFGH",
      browserId: "01234567",
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await pair.cancel();
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "cancelled" });
    expect(
      fetchMock.mock.calls
        .slice(2)
        .every(
          ([url, init]) =>
            String(url).endsWith("/cancel") &&
            JSON.parse(String(init?.body)).requestId === "request-1",
        ),
    ).toBe(true);
    expect(pair.onApproved).not.toHaveBeenCalled();
  });

  it("renders cancellation failure with a retry rather than hiding the request", async () => {
    const gate = await mountWaitingGate();
    const withdrawal = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(withdrawal.promise);
    const cancel = [...gate.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    expect(cancel).toBeDefined();
    cancel?.click();
    await settle();
    expect(gate.element.textContent).toContain("Withdrawing the request");
    expect(gate.element.querySelector(".login-gate__browser-pair-code")).not.toBeNull();
    withdrawal.reject(new Error("offline"));
    await settle();
    expect(gate.element.textContent).toContain("Could not confirm cancellation");
    const retry = [...gate.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry cancellation",
    );
    expect(retry).toBeDefined();
    vi.mocked(fetch).mockResolvedValueOnce(json({ status: "cancelled" }));
    retry?.click();
    await settle();
    expect(gate.element.textContent).toContain("Pairing request withdrawn");
    expect(gate.element.querySelector(".login-gate__browser-pair-code")).toBeNull();
    gate.approve();
    await settle();
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
  });

  it("ends an expired cancellation without claiming withdrawal or retrying", async () => {
    const fetchMock = stubReplies(
      json(started),
      json({ status: "pending" }),
      json({ status: "expired" }),
    );
    const pair = session();
    await pair.start(gatewayUrl);
    await settle();
    await pair.cancel();
    expect(pair.onState).toHaveBeenLastCalledWith({ kind: "failed", reason: "expired" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pair.onApproved).not.toHaveBeenCalled();
  });

  it("requires explicit Continue when approval wins cancellation", async () => {
    const gate = await mountWaitingGate();
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith("/cancel") ? json({ status: "approved" }) : json(approved),
    );
    const cancel = [...gate.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    expect(cancel).toBeDefined();
    cancel?.click();
    await settle();
    gate.approve();
    await settle();
    expect(gate.element.textContent).toContain("Cancel did not revoke its access");
    expect(gate.onBrowserPaired).not.toHaveBeenCalled();
    const proceed = [...gate.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue",
    );
    expect(proceed).toBeDefined();
    proceed?.click();
    await settle();
    expect(gate.onBrowserPaired).toHaveBeenCalledWith(gatewayUrl);
  });

  it("directs identity-required pairing to normal sign-in without a code", async () => {
    const fetchMock = stubReplies(json({ error: "identity_required" }, 403));
    const element = await mountFailure("", null);
    element.props = { ...element.props, gatewayUrl };
    await settle();
    element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-start")!.click();
    await settle();
    element.querySelector<HTMLButtonElement>(".login-gate__browser-pair-get")!.click();
    await settle();
    expect(element.textContent).toContain("This Gateway requires a verified identity");
    expect(element.textContent).toContain("normal identity-aware sign-in");
    expect(element.querySelector(".login-gate__browser-pair-code")).toBeNull();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(pair.onApproved).toHaveBeenCalledWith("ws://gateway.example");
  });

  it("connects with the approved token for this page when storage rejects writes", async () => {
    const url = "ws://blocked-storage.example";
    // A store that refuses writes, like a full quota or blocked site data.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    stubReplies(json(started), json(approved));
    const pair = session();
    await pair.start(url);
    await settle();
    expect(pair.onApproved).toHaveBeenCalledWith(url);
    // The next connect selects the received token even though nothing was persisted.
    const auth = selectBrowserGatewayConnectAuth(
      { url, token: "", password: "", bootstrapToken: "" },
      { role: "operator", deviceId: "0123456789abcdef" },
      false,
      false,
    );
    expect(auth).toMatchObject({
      resolvedDeviceToken: "device-token",
      usingStoredDeviceToken: true,
    });
  });

  it("offers pairing only for the Gateway serving this page", () => {
    expect(canPairBrowserWithGateway(gatewayUrl, "")).toBe(true);
    expect(canPairBrowserWithGateway(`${gatewayUrl}/team/`, "/team")).toBe(true);
    // Same host, different mount: another Gateway issues the approval.
    expect(canPairBrowserWithGateway(`${gatewayUrl}/other`, "/team")).toBe(false);
    expect(canPairBrowserWithGateway(gatewayUrl, "/team")).toBe(false);
    expect(canPairBrowserWithGateway("wss://other.example", "")).toBe(false);
    // A plain-HTTP page's Gateway answers on ws:; wss: on the same host is another listener.
    expect(window.location.protocol).toBe("http:");
    expect(canPairBrowserWithGateway(`wss://${window.location.host}`, "")).toBe(false);
    expect(canPairBrowserWithGateway(`http://${window.location.host}`, "")).toBe(false);
    expect(canPairBrowserWithGateway("", "")).toBe(false);
  });
});
