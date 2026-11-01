import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DebugOverlayContent } from "./debug-overlay-content.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function createDiagnosticsContext(
  request: (method: string) => Promise<unknown>,
  scopes: readonly string[],
): ApplicationContext {
  const { gateway, publish } = createApplicationGateway();
  publish({
    ...gateway.snapshot,
    phase: "connected",
    // SAFETY: Diagnostics only use the request method on this client fixture.
    client: { request } as unknown as GatewayBrowserClient,
    hello: gatewayHelloForMethods(["system.info"], scopes),
  });
  Object.assign(gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
  // SAFETY: This renderer only consumes the Gateway context capability.
  return { gateway } as ApplicationContext;
}

it("shows unavailable vitals and pauses the compact tray for session-only connections", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (method: string) =>
    method === "sessions.list" ? { sessions: [] } : { lanes: [], dynamic: null },
  );
  const context = createDiagnosticsContext(request, ["operator.sessions.read"]);
  const [minimized, setMinimized] = createSignal(false);
  const { container: content } = mountSolid(() => (
    <DebugOverlayContent context={context} minimized={minimized()} />
  ));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  const status = [...content.querySelectorAll(".debug-overlay__section")].find(
    (section) => section.querySelector("h3")?.textContent?.trim() === "Event loop / status",
  );
  expect(status?.textContent).toContain("Unavailable");
  expect(request.mock.calls.some(([method]) => method === "system.info")).toBe(false);
  setMinimized(true);
  flush();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(count);
  expect(content.querySelector(".debug-overlay__compact-loading")?.textContent).toContain(
    "Unavailable",
  );
});

it("retires the previous Gateway before expanding replacement diagnostics in the same turn", async () => {
  vi.useFakeTimers();
  const previousRequest = vi.fn(async () => ({}));
  const replacementRequest = vi.fn(async (method: string) => {
    if (method === "system.info") {
      return { eventLoop: { cpuCoreRatio: 0.25 } };
    }
    return method === "sessions.list" ? { sessions: [] } : { lanes: [], dynamic: null };
  });
  const [context, setContext] = createSignal(
    createDiagnosticsContext(previousRequest, ["operator.sessions.read"]),
  );
  const [minimized, setMinimized] = createSignal(true);
  const { container } = mountSolid(() => (
    <DebugOverlayContent context={context()} minimized={minimized()} />
  ));
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(container.querySelector(".debug-overlay__compact-loading")?.textContent).toContain(
    "Unavailable",
  );

  setContext(createDiagnosticsContext(replacementRequest, ["operator.read"]));
  setMinimized(false);
  flush();
  await vi.advanceTimersByTimeAsync(0);
  flush();

  expect(previousRequest).not.toHaveBeenCalled();
  expect(container.querySelector(".gateway-vital--cpu")?.textContent).toContain("0.25 cores");
});
