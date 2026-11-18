import { vi } from "vitest";
import type { createMcpBridgeFixture } from "../test-helpers/mcp-app-view-bridge.ts";

type BridgeFixture = Awaited<ReturnType<ReturnType<typeof createMcpBridgeFixture>>>;

export function createMcpAppBridgeMocks(bridgeMocks: {
  instances: Array<Record<string, unknown>>;
  transports: Array<Record<string, unknown>>;
  appModes: string[] | undefined;
}) {
  class AppBridge {
    oninitialized?: () => void;
    messageHandler?: BridgeFixture["bridge"]["messageHandler"];
    updateModelContextHandler?: BridgeFixture["bridge"]["updateModelContextHandler"];
    onsizechange?: (params: { height?: number }) => void;
    getAppCapabilities = () => ({ availableDisplayModes: bridgeMocks.appModes });
    setHostContext = vi.fn();
    teardownResource = vi.fn(async () => ({}));
    sendSandboxResourceReady = vi.fn(async () => undefined);
    sendToolInput = vi.fn(async () => undefined);
    sendToolResult = vi.fn(async () => undefined);
    onrequestteardown?: () => void;
    constructor(
      _client: unknown,
      _hostInfo: unknown,
      public capabilities: Record<string, unknown>,
      public options: Record<string, unknown>,
    ) {
      bridgeMocks.instances.push(this as unknown as Record<string, unknown>);
    }
    set onmessage(handler: NonNullable<AppBridge["messageHandler"]>) {
      this.messageHandler = handler;
    }
    set onupdatemodelcontext(handler: NonNullable<AppBridge["updateModelContextHandler"]>) {
      this.updateModelContextHandler = handler;
    }
    protected replaceRequestHandler() {}
    emit(type: string) {
      if (type === "requestteardown") {
        this.onrequestteardown?.();
      }
    }
    async connect() {
      this.oninitialized?.();
    }
  }
  class PostMessageTransport {
    close = vi.fn(async () => undefined);
    constructor() {
      bridgeMocks.transports.push(this as unknown as Record<string, unknown>);
    }
  }
  return { AppBridge, PostMessageTransport };
}
