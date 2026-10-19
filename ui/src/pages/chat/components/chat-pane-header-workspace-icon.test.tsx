/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { createSessionContext } from "../chat-pane.test-support.ts";
import { resolveChatPaneWorkspaceIcon } from "./chat-pane-header-identity.tsx";
import {
  mountChatPaneHeader,
  mockWorkspaceIconFetch,
  type ChatPaneHeaderProps,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

describe("chat pane workspace chip icon", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    containers.splice(0).forEach((container) => container.remove());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });
  async function mountChip(workspaceIcon: ChatPaneHeaderProps["workspaceIcon"]) {
    const { container } = mountHeader({ workspaceIcon });
    const element = container.querySelector("openclaw-workspace-icon");
    await element?.updateComplete;
    return { container, element };
  }

  it("keeps the folder glyph when the gateway resolved no project icon", async () => {
    const { container, element } = await mountChip(null);
    expect(element).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("keeps the folder glyph while credentials are not ready", async () => {
    const fetchSpy = mockWorkspaceIconFetch();
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: [],
      authReady: false,
    });
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releases a queued icon render on disconnect and recovers on reconnect", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    if (element) {
      element.authTokens = [...element.authTokens];
    }
    container.remove();
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    fetchSpy.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["icon"], { type: "image/png" }),
    } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reconnected-workspace-icon");
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await element?.updateComplete;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:reconnected-workspace-icon",
    );
  });

  it("recovers when a pending 503 settles between disconnect and immediate reconnect", async () => {
    const pending = createDeferred<Response>();
    const routeUrl = "/__openclaw__/workspace-icon/agent%3Amain%3Aimmediate-reconnect";
    const fetchSpy = mockWorkspaceIconFetch()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["icon"], { type: "image/png" }),
      } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:immediate-reconnect");
    const { container, element } = await mountChip({
      routeUrl,
      authTokens: ["token"],
      authReady: true,
    });
    container.remove();
    pending.resolve({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    await pending.promise;

    // Reattach in this task, before the deferred DOM-handoff release can delete the entry.
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([routeUrl, routeUrl]);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:immediate-reconnect",
    );
  });

  it("recovers the workspace icon after a transient 503 without remounting", async () => {
    // A previous header can disconnect with a property update still queued. Its
    // released retry must not consume the replacement header's response.
    mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const previous = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aprevious",
      authTokens: ["token"],
      authReady: true,
    });
    if (previous.element) {
      previous.element.authTokens = [...previous.element.authTokens];
    }
    previous.container.remove();
    await previous.element?.updateComplete;
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = mockWorkspaceIconFetch()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-workspace-icon");
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
    ]);
    expect(container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:recovered-workspace-icon",
    );
  });

  it("does not refetch a missing project icon when the header rerenders", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);
    const workspaceIcon = {
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    };
    const mounted = mountHeader({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await element?.updateComplete;
    mounted.update({ title: "Updated title", workspaceIcon });
    await element?.updateComplete;
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    mounted.update({ workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers an exhausted mounted icon after a new Gateway connection, not a header render", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const context = createSessionContext(createTestGatewayClient(async () => ({})));
    const initial = context.gateway.snapshot;
    if (!initial.hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...initial,
      hello: { ...initial.hello, server: { connId: "initial-connection" } },
    });
    const iconProps = () => resolveChatPaneWorkspaceIcon(context, "agent:main:connection");
    const mounted = mountHeader({ workspaceIcon: null });
    // Update one Solid root so recovery must retain the same workspace element.
    const paint = async () => {
      mounted.update({ workspaceIcon: iconProps() });
      const icon = mounted.container.querySelector<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("openclaw-workspace-icon");
      if (!icon) {
        throw new Error("expected a mounted workspace icon");
      }
      await icon.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await icon.updateComplete;
      return icon;
    };
    const element = await paint();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    const unchanged = context.gateway.snapshot;
    if (!unchanged.hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...unchanged,
      hello: { ...unchanged.hello, server: { ...unchanged.hello.server } },
    });
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mounted.container.querySelector(".workspace-icon")).toBeNull();

    fetchSpy.mockResolvedValue({ ok: true, blob: async () => new Blob(["icon"]) } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-gateway-connection");
    const snapshot = context.gateway.snapshot;
    const hello = snapshot.hello;
    if (!hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, server: { ...hello.server, connId: "new-connection" } },
    });
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(mounted.container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(mounted.container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:new-gateway-connection",
    );
  });
});
