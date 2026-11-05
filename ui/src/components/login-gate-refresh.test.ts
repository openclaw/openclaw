/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes as Codes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { registerControlUiReloadGuard } from "../app/document-reload-guard.ts";
import * as recovery from "../app/stale-chunk-reload.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { gatePart, mountFailure } from "./login-gate.test-support.ts";

const retry = recovery.retryStaleChunkReloadWhenReachable;
let reload: ReturnType<typeof vi.fn<() => void>>;
let probe: ReturnType<typeof vi.fn<() => Promise<{ ok: boolean }>>>;
const refresh = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>(".login-gate__failure-refresh")!;
const mountMismatch = () => mountFailure("protocol mismatch", Codes.PROTOCOL_MISMATCH);
const expectAttempt = () => expect(recovery.retryStaleChunkReloadWhenReachable);
function deferredProbe() {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean }>();
  probe.mockReturnValueOnce(promise);
  return () => resolve({ ok: true });
}
async function pendingRefresh() {
  const finish = deferredProbe();
  const element = await mountMismatch();
  refresh(element).click();
  return { element, finish };
}
async function expectCancelled() {
  await vi.waitFor(() => expectAttempt().toHaveResolvedWith(false));
  expect(reload).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  reload = vi.fn();
  probe = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal("fetch", probe);
  // Exercise production retry/probe/election; replace only final navigation.
  vi.spyOn(recovery, "retryStaleChunkReloadWhenReachable").mockImplementation((deps) =>
    retry({ ...deps, reload }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("waits through a failed HEAD handoff probe and admits only one click", async () => {
  vi.useFakeTimers();
  probe.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
  const element = await mountMismatch();
  refresh(element).click();
  refresh(element).click();
  await element.updateComplete;
  expectAttempt().toHaveBeenCalledOnce();
  expect(refresh(element).disabled).toBe(true);
  expect(refresh(element).textContent).toContain("Refreshing");
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenCalledWith(
    new URL("/index.html", window.location.href).href,
    expect.objectContaining({
      method: "HEAD",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(reload).toHaveBeenCalledOnce();
});
it.each(["bounded wait", "rejected retry"])("returns to Retry after %s", async (failure) => {
  vi.useFakeTimers();
  if (failure === "rejected retry") {
    vi.mocked(recovery.retryStaleChunkReloadWhenReachable).mockRejectedValueOnce(new Error());
  }
  const element = await mountMismatch();
  const button = refresh(element);
  button.focus();
  button.click();
  await vi.advanceTimersByTimeAsync(failure === "bounded wait" ? 30_000 : 0);
  await element.updateComplete;
  expect(reload).not.toHaveBeenCalled();
  expect(refresh(element).disabled).toBe(false);
  expect(refresh(element).textContent?.trim()).toBe("Retry");
  expect(refresh(element)).toBe(button);
  expect(document.activeElement).toBe(button);
  const finish = deferredProbe();
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh(element)).toBe(button);
  expect(button.disabled).toBe(true);
  expect(button.textContent?.trim()).toBe("Refreshing…");
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledOnce();
});
it.each([
  ["connected", { connected: true }],
  ["dismissed failure", { lastError: null, lastErrorCode: null }],
  ["replacement failure", { lastError: "replacement protocol mismatch" }],
  ["replacement code", { lastErrorCode: Codes.AUTH_REQUIRED }],
  ["replacement auth reason", { lastErrorAuthReason: "replacement-reason" }],
  ["reconnect", { reconnectPending: true }],
  ["target", { gatewayUrl: "ws://another.example" }],
  ["resource base", { resourceBasePath: "/replacement-ui" }],
  ["credential", { secret: "replacement-secret" }],
])("cancels a pending probe on %s", async (_name, props) => {
  const { element, finish } = await pendingRefresh();
  element.props = { ...element.props, ...props };
  // Final navigation must see changed properties before Solid renders them.
  finish();
  await expectCancelled();
});
it.each(["Connect", "Enter", "target input", "credential input", "remove and reinsert"])(
  "retires the attempt synchronously on %s",
  async (action) => {
    const { element, finish } = await pendingRefresh();
    if (action === "Connect") {
      gatePart(element, "connect").click();
      expect(element.props.onConnect).toHaveBeenCalledOnce();
    } else if (action === "remove and reinsert") {
      element.remove();
      document.body.append(element);
    } else {
      const input = element.querySelector<HTMLInputElement>(
        action === "target input" ? "#login-gate-url" : "#login-gate-credential",
      )!;
      if (action === "Enter") {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(element.props.onConnect).toHaveBeenCalledOnce();
      } else {
        input.value = "new-value";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    finish();
    await expectCancelled();
  },
);
it("keeps the same attempt through unrelated rendering", async () => {
  const { element, finish } = await pendingRefresh();
  element.props = {
    ...element.props,
    showGatewaySecret: true,
    onConnect: vi.fn(),
    connected: false,
    reconnectPending: false,
  };
  await element.updateComplete;
  expect(refresh(element).disabled).toBe(true);
  expect(refresh(element).textContent).toContain("Refreshing");
  expectAttempt().toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});
it("retires an attempt when its identity changes and then returns", async () => {
  const { element, finish } = await pendingRefresh();
  const original = element.props;
  element.props = { ...original, lastError: "replacement protocol mismatch" };
  await element.updateComplete;
  element.props = original;
  await element.updateComplete;
  expect(refresh(element).disabled).toBe(false);
  finish();
  await expectCancelled();
});
it("keeps a replacement attempt when the previous probe settles", async () => {
  const { element, finish } = await pendingRefresh();
  element.props = { ...element.props, lastError: "replacement protocol mismatch" };
  await element.updateComplete;
  refresh(element).click();
  await element.updateComplete;
  expectAttempt().toHaveBeenCalledTimes(2);
  expect(refresh(element).disabled).toBe(true);
  expect(probe).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expectAttempt().toHaveResolvedWith(false);
  expectAttempt().toHaveResolvedWith(true);
  expect(probe).toHaveBeenCalledOnce();
});
it.each(["automatic first", "manual first"])("navigates once with %s", async (order) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const finish = deferredProbe();
  const element = await mountMismatch();
  const deps = { storage: sessionStorage, buildId: "new-build", reload };
  let automatic: Promise<boolean>;
  if (order === "automatic first") {
    automatic = recovery.scheduleStaleChunkReload(deps);
    refresh(element).click();
  } else {
    refresh(element).click();
    automatic = recovery.scheduleStaleChunkReload(deps);
  }
  finish();
  await automatic;
  await vi.waitFor(() => expectAttempt().toHaveResolved());
  expect(probe).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});
it("rechecks unsaved-input guards after the probe without discarding data", async () => {
  let unsaved = false;
  const explain = vi.fn();
  const release = registerControlUiReloadGuard(() => !unsaved, explain);
  try {
    const { finish } = await pendingRefresh();
    unsaved = true;
    finish();
    await expectCancelled();
    expect(explain).toHaveBeenCalled();
  } finally {
    release();
  }
});
