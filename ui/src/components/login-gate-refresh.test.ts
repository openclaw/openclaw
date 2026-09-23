/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { registerControlUiReloadGuard } from "../app/document-reload-guard.ts";
import * as recovery from "../app/stale-chunk-reload.ts";
import "./login-gate.ts";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<boolean>;
};
const retry = recovery.retryStaleChunkReloadWhenReachable;
let reload: ReturnType<typeof vi.fn<() => void>>;
let probe: ReturnType<typeof vi.fn<() => Promise<{ ok: boolean }>>>;
let storage: Storage;

async function mountFailure() {
  const element = document.createElement("openclaw-login-gate") as LoginGateElement;
  element.props = {
    resourceBasePath: "",
    connected: false,
    lastError: "protocol mismatch",
    lastErrorCode: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    hasToken: false,
    hasPassword: false,
    gatewayUrl: "ws://127.0.0.1:18789",
    secret: "",
    showGatewaySecret: false,
    onGatewayUrlChange: vi.fn(),
    onSecretChange: vi.fn(),
    onToggleGatewaySecret: vi.fn(),
    onConnect: vi.fn(),
  };
  document.body.append(element);
  await element.updateComplete;
  return element;
}
function refresh(element: HTMLElement) {
  return element.querySelector<HTMLButtonElement>(".login-gate__failure-refresh")!;
}
function deferredProbe() {
  let resolve!: (value: { ok: boolean }) => void;
  probe.mockImplementationOnce(
    () =>
      new Promise<{ ok: boolean }>((done) => {
        resolve = done;
      }),
  );
  return () => resolve({ ok: true });
}
beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
  vi.stubGlobal("sessionStorage", storage);
  reload = vi.fn();
  probe = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal("fetch", probe);
  // Exercise production retry/probe/election; replace only final navigation.
  vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable").mockImplementation((deps) =>
    retry({ ...deps, reload }),
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("login refresh ownership", () => {
  it("waits through a failed HEAD handoff probe and admits only one click", async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    const element = await mountFailure();
    refresh(element).click();
    refresh(element).click();
    await element.updateComplete;
    expect(recovery.retryStaleChunkReloadWhenReachable).toHaveBeenCalledOnce();
    expect(refresh(element).disabled).toBe(true);
    expect(refresh(element).textContent).toContain("Refreshing");
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(
      window.location.href,
      expect.objectContaining({
        method: "HEAD",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(reload).toHaveBeenCalledOnce();
  });
  it("returns to Retry after the bounded wait, then allows a successful attempt", async () => {
    vi.useFakeTimers();
    const element = await mountFailure();
    refresh(element).click();
    await vi.advanceTimersByTimeAsync(30_000);
    await element.updateComplete;
    expect(reload).not.toHaveBeenCalled();
    expect(refresh(element).disabled).toBe(false);
    expect(refresh(element).textContent?.trim()).toBe("Retry");
    probe.mockResolvedValue({ ok: true });
    refresh(element).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("contains a rejected retry and leaves visible Retry feedback", async () => {
    vi.mocked(recovery.retryStaleChunkReloadWhenReachable).mockRejectedValueOnce(
      new Error("probe failed"),
    );
    const element = await mountFailure();
    refresh(element).click();
    await vi.waitFor(() => expect(refresh(element).textContent?.trim()).toBe("Retry"));
    expect(refresh(element).disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it.each([
    ["connected", { connected: true }],
    ["dismissed failure", { lastError: null, lastErrorCode: null }],
    ["replacement failure", { lastError: "replacement protocol mismatch" }],
    ["replacement code", { lastErrorCode: ConnectErrorDetailCodes.AUTH_REQUIRED }],
    ["reconnect", { reconnectPending: true }],
    ["target", { gatewayUrl: "ws://another.example" }],
    ["credential", { secret: "replacement-secret" }],
  ])("cancels a pending probe on %s", async (_name, props) => {
    const finish = deferredProbe();
    const element = await mountFailure();
    refresh(element).click();
    element.props = { ...element.props, ...props };
    // Final navigation must see changed properties before Lit renders them.
    finish();
    await vi.waitFor(() =>
      expect(recovery.retryStaleChunkReloadWhenReachable).toHaveResolvedWith(false),
    );
    expect(reload).not.toHaveBeenCalled();
  });
  it.each(["Connect", "Enter", "target input", "credential input", "remove and reinsert"])(
    "retires the attempt synchronously on %s",
    async (action) => {
      const finish = deferredProbe();
      const element = await mountFailure();
      refresh(element).click();
      if (action === "Connect") {
        element.querySelector<HTMLButtonElement>(".login-gate__connect")!.click();
        expect(element.props.onConnect).toHaveBeenCalledOnce();
      } else if (action === "remove and reinsert") {
        element.remove();
        document.body.append(element);
      } else {
        const input = element.querySelector<HTMLInputElement>(
          action === "target input" ? "#login-gate-url" : "#login-gate-credential",
        )!;
        if (action === "Enter") {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
          expect(element.props.onConnect).toHaveBeenCalledOnce();
        } else {
          input.value = "new-value";
          input.dispatchEvent(new Event("input"));
        }
      }
      finish();
      await vi.waitFor(() =>
        expect(recovery.retryStaleChunkReloadWhenReachable).toHaveResolvedWith(false),
      );
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it("keeps the same attempt through unrelated rendering", async () => {
    const finish = deferredProbe();
    const element = await mountFailure();
    refresh(element).click();
    element.props = { ...element.props, showGatewaySecret: true, onConnect: vi.fn() };
    await element.updateComplete;
    finish();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
  it.each(["automatic first", "manual first"])("navigates once with %s", async (order) => {
    const finish = deferredProbe();
    const element = await mountFailure();
    let automatic: Promise<boolean>;
    if (order === "automatic first") {
      automatic = recovery.scheduleStaleChunkReload({ storage, buildId: "new-build", reload });
      refresh(element).click();
    } else {
      refresh(element).click();
      automatic = recovery.scheduleStaleChunkReload({ storage, buildId: "new-build", reload });
    }
    finish();
    await automatic;
    await vi.waitFor(() => expect(recovery.retryStaleChunkReloadWhenReachable).toHaveResolved());
    expect(probe).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
  it("rechecks unsaved-input guards after the probe without discarding data", async () => {
    const finish = deferredProbe();
    const element = await mountFailure();
    let unsaved = false;
    const explain = vi.fn();
    const release = registerControlUiReloadGuard(() => !unsaved, explain);
    try {
      refresh(element).click();
      unsaved = true;
      finish();
      await vi.waitFor(() =>
        expect(recovery.retryStaleChunkReloadWhenReachable).toHaveResolvedWith(false),
      );
      expect(explain).toHaveBeenCalled();
      expect(unsaved).toBe(true);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
