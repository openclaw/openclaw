import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import * as mcpContexts from "../lib/mcp-app-context.ts";
import { publishMcpAppContext, readMcpAppContexts } from "../lib/mcp-app-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppContextStrip } from "./solid/mcp-app-context-strip.tsx";

const binding = { sessionKey: "agent:main:one", agentId: "main", viewId: "view-one" };
const state = {
  updateId: "revision-one",
  content: [{ type: "text" as const, text: "bolt", _meta: { "openai/title": "Hex bolt" } }],
};
function mountStrip(context: ApplicationContext) {
  return mountSolid(
    () => <McpAppContextStrip sessionKey={binding.sessionKey} agentId={binding.agentId} />,
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
}
function mountContext(request: GatewayRequestHandler = vi.fn(async () => ({ state }))) {
  const client = createTestGatewayClient(request);
  const application = createApplicationGateway();
  application.publish({ ...application.gateway.snapshot, client, phase: "connected" });
  publishMcpAppContext(client, { ...binding, title: "Library", state });
  const { container: strip, unmount } = mountStrip({
    gateway: application.gateway,
  } as ApplicationContext);
  flush();
  expect(strip.textContent).toContain("Hex bolt");
  return {
    client,
    strip,
    application,
    unmount,
    emit: (payload: Record<string, unknown>) => {
      application.publishEvent({ type: "event", event: "mcp.app.hostContextChanged", payload });
      flush();
    },
  };
}

it("clears consumed context immediately", () => {
  const { strip, emit } = mountContext();
  emit({ viewId: "another-view", modelContext: null, updateId: "revision-one" });
  expect(strip.textContent).toContain("Hex bolt");
  emit({ viewId: "view-one", modelContext: null, updateId: "earlier-revision" });
  expect(strip.textContent).toContain("Hex bolt");
  emit({ viewId: "view-one", modelContext: null, updateId: "revision-one" });
  expect.soft(strip.textContent?.trim()).toBe("");
  expect(strip.querySelector('[role="alert"]')).toBeNull();
});
it("releases a failed removal for retry and clears an idempotent response", async () => {
  const removal = createDeferred<{ state: null }>();
  const request = vi.fn().mockReturnValueOnce(removal.promise).mockResolvedValue({ state: null });
  const { client, strip } = mountContext(request);
  const remove = strip.querySelector<HTMLButtonElement>("button")!;
  remove.click();
  flush();
  expect(remove.disabled).toBe(true);
  removal.reject(new Error("Removal unavailable"));
  await waitForSolid(() =>
    expect(strip.querySelector('[role="alert"]')?.textContent).toContain("Removal unavailable"),
  );
  expect(remove.disabled).toBe(false);
  expect(strip.textContent).toContain("Hex bolt");
  remove.click();
  await waitForSolid(() => expect(strip.textContent?.trim()).toBe(""));
  expect(request).toHaveBeenCalledWith("mcp.app.removeModelContext", {
    ...binding,
    updateId: "revision-one",
    index: 0,
  });
  expect(readMcpAppContexts(client, "agent:main:one", "main")).toEqual([]);
  expect(strip.querySelector('[role="alert"]')).toBeNull();
});

it("releases each context subscription when its client is replaced or the strip unmounts", () => {
  const subscribe = mcpContexts.subscribeMcpAppContexts;
  const releases: Mock<() => void>[] = [];
  const releaseCounts = () => releases.map((release) => release.mock.calls.length);
  const subscription = vi
    .spyOn(mcpContexts, "subscribeMcpAppContexts")
    .mockImplementation((client, listener) => {
      const release = vi.fn(subscribe(client, listener));
      releases.push(release);
      return release;
    });
  const { application, unmount } = mountContext();
  const secondClient = createTestGatewayClient(async () => ({}));
  try {
    expect(releaseCounts()).toEqual([0]);
    application.publish({ ...application.gateway.snapshot, client: secondClient });
    flush();
    expect(subscription).toHaveBeenLastCalledWith(secondClient, expect.any(Function));
    expect(releaseCounts()).toEqual([1, 0]);
    unmount();
    expect(releaseCounts()).toEqual([1, 1]);
  } finally {
    unmount();
    subscription.mockRestore();
  }
});
