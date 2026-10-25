import { createSignal } from "solid-js";
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
  let selectSession!: (sessionKey: string) => void;
  const mounted = mountSolid(
    () => {
      const [sessionKey, setSessionKey] = createSignal(binding.sessionKey);
      selectSession = setSessionKey;
      return <McpAppContextStrip sessionKey={sessionKey()} agentId={binding.agentId} />;
    },
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  return { ...mounted, selectSession };
}
async function mountContext(request: GatewayRequestHandler = vi.fn(async () => ({ state }))) {
  const client = createTestGatewayClient(request);
  const application = createApplicationGateway();
  application.publish({ ...application.gateway.snapshot, client, phase: "connected" });
  publishMcpAppContext(client, { ...binding, title: "Library", state });
  const {
    container: strip,
    unmount,
    selectSession,
  } = mountStrip({
    gateway: application.gateway,
  } as ApplicationContext);
  flush();
  await waitForSolid(() => expect(strip.textContent).toContain("Hex bolt"));
  return {
    client,
    strip,
    application,
    unmount,
    selectSession,
    emit: (payload: Record<string, unknown>) => {
      application.publishEvent({ type: "event", event: "mcp.app.hostContextChanged", payload });
      flush();
    },
  };
}

it("clears consumed context immediately", async () => {
  const { strip, emit } = await mountContext();
  emit({ viewId: "another-view", modelContext: null, updateId: "revision-one" });
  expect(strip.textContent).toContain("Hex bolt");
  emit({ viewId: "view-one", modelContext: null, updateId: "earlier-revision" });
  expect(strip.textContent).toContain("Hex bolt");
  emit({ viewId: "view-one", modelContext: null, updateId: "revision-one" });
  expect.soft(strip.textContent?.trim()).toBe("");
  expect(strip.querySelector('[role="alert"]')).toBeNull();
});
it("retains accepted context after a failed refresh and accepts the next update", async () => {
  const failed = createDeferred<{ state: null }>();
  const request = vi
    .fn()
    .mockReturnValueOnce(failed.promise)
    .mockResolvedValueOnce({
      state: {
        updateId: "revision-two",
        content: [{ type: "text", text: "socket", _meta: { "openai/title": "Socket" } }],
      },
    });
  const { strip, emit } = await mountContext(request);
  emit({ viewId: binding.viewId });
  failed.reject(new Error("Context temporarily unavailable"));
  await failed.promise.catch(() => {});
  await Promise.resolve();
  flush();
  expect(strip.textContent).toContain("Hex bolt");
  expect(strip.querySelector('[role="alert"]')).toBeNull();
  emit({ viewId: binding.viewId });
  await waitForSolid(() => expect(strip.textContent).toContain("Socket"));
  emit({ viewId: binding.viewId, modelContext: null, updateId: "revision-two" });
  expect(strip.textContent?.trim()).toBe("");
});

it("lets the latest event refresh own the next context publication", async () => {
  const first = createDeferred<{ state: typeof state }>();
  const second = createDeferred<{ state: typeof state }>();
  const { strip, emit } = await mountContext(
    vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  );
  emit({ viewId: binding.viewId });
  emit({ viewId: binding.viewId });
  first.resolve({
    state: {
      updateId: "superseded",
      content: [{ type: "text", text: "stale", _meta: { "openai/title": "Stale answer" } }],
    },
  });
  await first.promise;
  await Promise.resolve();
  flush();
  expect(strip.textContent).toContain("Hex bolt");
  second.resolve({
    state: {
      updateId: "latest",
      content: [{ type: "text", text: "socket", _meta: { "openai/title": "Socket" } }],
    },
  });
  await waitForSolid(() => expect(strip.textContent).toContain("Socket"));
});

it.each(["clear", "newer context", "client", "session", "unmount"] as const)(
  "does not republish a held refresh after %s retires its entry",
  async (retirement) => {
    const pending = createDeferred<{ state: typeof state }>();
    const { client, strip, emit, selectSession, application, unmount } = await mountContext(
      vi.fn(() => pending.promise),
    );
    emit({ viewId: binding.viewId });
    if (retirement === "clear") {
      emit({ viewId: binding.viewId, modelContext: null, updateId: state.updateId });
    } else if (retirement === "newer context") {
      publishMcpAppContext(client, {
        ...binding,
        title: "Library",
        state: { ...state, updateId: "revision-two" },
      });
    } else if (retirement === "client") {
      application.publish({
        ...application.gateway.snapshot,
        client: createTestGatewayClient(async () => ({})),
      });
    } else if (retirement === "session") {
      selectSession("agent:main:two");
    } else {
      unmount();
    }
    flush();
    const accepted = readMcpAppContexts(client, binding.sessionKey, binding.agentId);
    pending.resolve({
      state: {
        updateId: "late-refresh",
        content: [{ type: "text", text: "stale", _meta: { "openai/title": "Stale answer" } }],
      },
    });
    await pending.promise;
    await Promise.resolve();
    flush();
    expect(readMcpAppContexts(client, binding.sessionKey, binding.agentId)).toEqual(accepted);
    expect(strip.textContent).not.toContain("Stale answer");
  },
);

it("releases a failed removal for retry and clears an idempotent response", async () => {
  const removal = createDeferred<{ state: null }>();
  const retry = createDeferred<{ state: null }>();
  const request = vi.fn().mockReturnValueOnce(removal.promise).mockReturnValueOnce(retry.promise);
  const { client, strip } = await mountContext(request);
  const remove = strip.querySelector<HTMLButtonElement>("button")!;
  remove.click();
  await waitForSolid(() => expect(remove.disabled).toBe(true));
  removal.reject(new Error("Removal unavailable"));
  await waitForSolid(() =>
    expect(strip.querySelector('[role="alert"]')?.textContent).toContain("Removal unavailable"),
  );
  expect(remove.disabled).toBe(false);
  expect(strip.textContent).toContain("Hex bolt");
  remove.click();
  await waitForSolid(() => {
    expect(remove.disabled).toBe(true);
    expect(strip.querySelector('[role="alert"]')).toBeNull();
  });
  expect(strip.querySelector("button")).toBe(remove);
  expect(strip.textContent).toContain("Hex bolt");
  retry.resolve({ state: null });
  await waitForSolid(() => expect(strip.textContent?.trim()).toBe(""));
  expect(request).toHaveBeenCalledWith("mcp.app.removeModelContext", {
    ...binding,
    updateId: "revision-one",
    index: 0,
  });
  expect(readMcpAppContexts(client, "agent:main:one", "main")).toEqual([]);
  expect(strip.querySelector('[role="alert"]')).toBeNull();
});

it("leaves a failed removal behind when the visible session changes", async () => {
  const { client, strip, selectSession } = await mountContext(
    vi.fn(async () => {
      throw new Error("Removal unavailable");
    }),
  );
  strip.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() => expect(strip.querySelector('[role="alert"]')).not.toBeNull());
  publishMcpAppContext(client, {
    ...binding,
    sessionKey: "agent:main:two",
    title: "Successor",
    state: {
      ...state,
      content: [{ type: "text", text: "socket", _meta: { "openai/title": "Socket" } }],
    },
  });
  selectSession("agent:main:two");
  await waitForSolid(() => {
    expect(strip.textContent).toContain("Socket");
    expect(strip.querySelector('[role="alert"]')).toBeNull();
  });
});

it.each(["client", "session"] as const)(
  "isolates pending removal across a %s replacement with the same view ID",
  async (replacement) => {
    const first = createDeferred<{ state: null }>();
    const second = createDeferred<{ state: null }>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { client, strip, application, selectSession, unmount } = await mountContext(request);
    try {
      strip.querySelector<HTMLButtonElement>("button")!.click();
      await waitForSolid(() =>
        expect(strip.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true),
      );
      const nextClient = replacement === "client" ? createTestGatewayClient(request) : client;
      const sessionKey = replacement === "session" ? "agent:main:two" : binding.sessionKey;
      const nextState = {
        updateId: "replacement-revision",
        content: [{ type: "text" as const, text: "socket", _meta: { "openai/title": "Socket" } }],
      };
      publishMcpAppContext(nextClient, {
        ...binding,
        sessionKey,
        title: "Successor",
        state: nextState,
      });
      if (replacement === "client") {
        application.publish({ ...application.gateway.snapshot, client: nextClient });
      } else {
        selectSession(sessionKey);
      }
      flush();
      expect(strip.textContent).toContain("Socket");
      const remove = strip.querySelector<HTMLButtonElement>("button")!;
      expect(remove.disabled).toBe(false);
      remove.click();
      await waitForSolid(() => expect(remove.disabled).toBe(true));
      first.resolve({ state: null });
      await first.promise;
      await Promise.resolve();
      flush();
      expect(remove.disabled).toBe(true);
      expect(readMcpAppContexts(nextClient, sessionKey, binding.agentId)[0]?.state).toEqual(
        nextState,
      );
      second.reject(new Error("Successor removal unavailable"));
      await waitForSolid(() => {
        expect(strip.querySelector('[role="alert"]')?.textContent).toContain(
          "Successor removal unavailable",
        );
        expect(remove.disabled).toBe(false);
      });
      expect(strip.textContent).toContain("Socket");
    } finally {
      unmount();
      first.resolve({ state: null });
      second.resolve({ state: null });
    }
  },
);

it("retires a held removal and its event listener when the strip unmounts", async () => {
  const removal = createDeferred<{ state: null }>();
  const { client, strip, emit, unmount } = await mountContext(vi.fn(() => removal.promise));
  strip.querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() =>
    expect(strip.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true),
  );
  unmount();
  emit({ viewId: binding.viewId, modelContext: null, updateId: state.updateId });
  expect(readMcpAppContexts(client, binding.sessionKey, binding.agentId)[0]?.state).toEqual(state);
  removal.resolve({ state: null });
  await removal.promise;
  await Promise.resolve();
  flush();
  expect(readMcpAppContexts(client, binding.sessionKey, binding.agentId)[0]?.state).toEqual(state);
});

it("releases each context subscription when its client is replaced or the strip unmounts", async () => {
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
  const { application, unmount } = await mountContext();
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
