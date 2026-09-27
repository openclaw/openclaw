import { vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import type { GatewayChatClient } from "./gateway-chat.js";

export async function withGatewayChatConnection(
  request: (method: string, params?: unknown) => Promise<unknown>,
  run: (client: GatewayChatClient, callbacks: GatewayClientOptions) => Promise<void>,
) {
  const transport: { options?: GatewayClientOptions } = {};
  let client: GatewayChatClient | undefined;
  vi.resetModules();
  vi.doMock("../gateway/client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../gateway/client.js")>();
    return {
      ...actual,
      GatewayClient: class {
        request = request;
        stopAndWait() {
          return Promise.resolve();
        }
        constructor(options: GatewayClientOptions) {
          transport.options = options;
        }
      },
    };
  });
  try {
    const { GatewayChatClient: Client } = await import("./gateway-chat.js");
    client = new Client({ url: "ws://127.0.0.1:18789", token: "test-token" });
    const callbacks = transport.options;
    if (!callbacks?.onHelloOk || !callbacks.onClose) {
      throw new Error("Gateway client did not register its connection lifecycle");
    }
    await run(client, callbacks);
  } finally {
    await client?.stop();
    vi.doUnmock("../gateway/client.js");
    vi.resetModules();
  }
}
