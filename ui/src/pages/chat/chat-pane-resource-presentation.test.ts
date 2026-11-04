// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";
import { createChatPaneResourceProps } from "./chat-pane-resource-presentation.ts";

function setup() {
  const request = vi.fn(async () => ({
    encoding: "base64",
    data: "AA==",
    artifact: { type: "image", mimeType: "image/png" },
  }));
  const client = createTestGatewayClient(request);
  const state = createTestPageState(makeChatHost({ client, connected: true, connectionEpoch: 1 }));
  const context = createInitializationContext(client);
  const props = createChatPaneResourceProps();
  return { state, context, props, request };
}

const params = { sessionKey: "agent:main:test", artifactId: "artifact-1" };

describe("deferred pane artifact downloads", () => {
  it("keeps the download owner stable and resolves on the current connection", async () => {
    const { state, context, props, request } = setup();
    const resolve = props(state, context).resolveArtifactDownload;
    expect(props(state, context).resolveArtifactDownload).toBe(resolve);
    await expect(resolve(params)).resolves.toEqual({ url: "data:image/png;base64,AA==" });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("artifacts.download", expect.objectContaining(params), {
      timeoutMs: 30_000,
    });
  });

  it.each(["client", "epoch", "abort", "disconnect"] as const)(
    "does not start a download when %s changes while loading the downloader",
    async (change) => {
      const { state, context, props, request } = setup();
      const controller = new AbortController();
      const pending = props(state, context).resolveArtifactDownload(params, controller.signal);
      if (change === "client") {
        state.client = createTestGatewayClient(request);
      } else if (change === "epoch") {
        state.connectionEpoch += 1;
      } else if (change === "abort") {
        controller.abort();
      } else {
        state.connected = false;
      }
      await expect(pending).resolves.toBeNull();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("does not adopt a connection established after a disconnected request", async () => {
    const { state, context, props, request } = setup();
    state.connected = false;
    const pending = props(state, context).resolveArtifactDownload(params);
    state.connected = true;
    await expect(pending).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
