import type { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import "./debug-overlay-content.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("shows unavailable vitals and pauses the compact tray for session-only connections", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (method: string) =>
    method === "sessions.list" ? { sessions: [] } : { lanes: [], dynamic: null },
  );
  const { gateway } = createApplicationGateway({
    phase: "connected",
    client: { request } as unknown as GatewayBrowserClient,
    hello: gatewayHelloForMethods(["system.info"], ["operator.sessions.read"]),
  } as ApplicationGatewaySnapshot);
  Object.assign(gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
  const content = document.createElement("openclaw-debug-overlay-content") as LitElement & {
    context: ApplicationContext;
    minimized: boolean;
  };
  content.context = { gateway } as ApplicationContext;
  document.body.append(content);
  await settleLitElement(content);
  const status = [...content.querySelectorAll(".debug-overlay__section")].find(
    (section) => section.querySelector("h3")?.textContent?.trim() === "Event loop / status",
  );
  expect(status?.textContent).toContain("Unavailable");
  expect(request.mock.calls.some(([method]) => method === "system.info")).toBe(false);
  content.minimized = true;
  await settleLitElement(content);
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(count);
  expect(content.querySelector(".debug-overlay__compact-loading")?.textContent).toContain(
    "Unavailable",
  );
});
