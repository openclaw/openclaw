/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { createSessionContext } from "../chat-application-context.test-support.ts";
import { resolveChatPaneWorkspaceIcon } from "../chat-pane-header-identity.ts";
import { mountChatPaneHeader, mockWorkspaceIconFetch } from "./chat-pane-header.test-support.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

const iconOptions = (name: string, authReady = true) => ({
  routeUrl: `/__openclaw__/workspace-icon/agent%3Amain%3A${name}`,
  authTokens: authReady ? ["token"] : [],
  authReady,
});
const unavailable = () => new Response(null, { status: 503, headers: { "retry-after": "1" } });
const iconResponse = () =>
  Object.assign(new Response(), {
    blob: async () => new Blob(["icon"], { type: "image/png" }),
  });
const iconSource = (container: HTMLElement) =>
  container.querySelector<HTMLImageElement>(".workspace-icon")?.src;

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
    const { container, element } = await mountChip(iconOptions("one", false));
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recovers when a pending 503 settles between disconnect and immediate reconnect", async () => {
    const pending = createDeferred<Response>();
    const options = iconOptions("immediate-reconnect");
    const fetchSpy = mockWorkspaceIconFetch()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(iconResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:immediate-reconnect");
    const { container, element } = await mountChip(options);
    container.remove();
    pending.resolve(unavailable());
    await pending.promise;

    // Reattach in this task, before the deferred DOM-handoff release can delete the entry.
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([options.routeUrl, options.routeUrl]);
    expect(iconSource(container)).toBe("blob:immediate-reconnect");
  });

  it("recovers the workspace icon after a transient 503 without remounting", async () => {
    // A previous header can disconnect with a property update still queued. Its
    // released retry must not consume the replacement header's response.
    mockWorkspaceIconFetch().mockResolvedValue(unavailable());
    const previous = await mountChip(iconOptions("previous"));
    if (previous.element) {
      previous.element.authTokens = [...previous.element.authTokens];
    }
    previous.container.remove();
    await previous.element?.updateComplete;
    const fetchSpy = mockWorkspaceIconFetch()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(iconResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-workspace-icon");
    const options = iconOptions("recovering");
    const { container, element } = await mountChip(options);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([options.routeUrl, options.routeUrl]);
    expect(container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(iconSource(container)).toBe("blob:recovered-workspace-icon");
  });

  it("retries a missing project icon when header credentials change", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const workspaceIcon = iconOptions("one");
    const mounted = mountHeader({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon");

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await element?.updateComplete;
    mounted.update({ workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers an exhausted mounted icon after a new Gateway connection, not a header render", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue(unavailable());
    const context = createSessionContext(createTestGatewayClient(async () => ({})));
    const publishConnection = (connId: string) => {
      const snapshot = context.gateway.snapshot;
      const hello = snapshot.hello;
      if (!hello) {
        throw new Error("expected a connected Gateway fixture");
      }
      context.publishGatewaySnapshot({
        ...snapshot,
        hello: { ...hello, server: { ...hello.server, connId } },
      });
    };
    publishConnection("initial-connection");
    const iconProps = () =>
      resolveChatPaneWorkspaceIcon({
        sessionKey: "agent:main:connection",
        resourceBasePath: context.resourceBasePath,
        hello: context.gateway.snapshot.hello,
        token: context.gateway.connection.token,
        password: context.gateway.connection.password,
      });
    const mounted = mountHeader({ workspaceIcon: null });
    // Update one Solid root so recovery must retain the same workspace element.
    const paint = async () => {
      mounted.update({ workspaceIcon: iconProps() });
      const icon = mounted.container.querySelector("openclaw-workspace-icon");
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
    publishConnection("initial-connection");
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mounted.container.querySelector(".workspace-icon")).toBeNull();

    fetchSpy.mockResolvedValue(iconResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-gateway-connection");
    publishConnection("new-connection");
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(mounted.container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(iconSource(mounted.container)).toBe("blob:new-gateway-connection");
  });
});
