import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { bindMcpAppResourceHandlers, OpenClawAppBridge } from "./mcp-app-bridge.ts";
import { buildMcpAppHostCapabilities } from "./mcp-app-security.ts";

it("round-trips opaque list cursors through the installed AppBridge transport", async () => {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new OpenClawAppBridge(
    null,
    { name: "OpenClaw", version: "test" },
    buildMcpAppHostCapabilities(undefined, true, false),
  );
  const app = new App({ name: "cursor-proof", version: "1" }, {}, { autoResize: false });
  let cursor = "";
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const second = Object.hasOwn(params, "cursor") && params.cursor === cursor;
    const name = second ? "second" : "first";
    return {
      ...(method === "mcp.app.listTools"
        ? { tools: [{ name, inputSchema: { type: "object" } }] }
        : { resourceTemplates: [{ name, uriTemplate: `fixture://${name}/{id}` }] }),
      ...(second ? {} : { nextCursor: cursor }),
    };
  });
  bindMcpAppResourceHandlers({
    bridge,
    request,
    sessionKey: "one",
    viewId: "app",
    iframe: document.createElement("iframe"),
    confirmOpenFile: async () => false,
    isDisposed: () => false,
    addCleanup: () => {},
    dispatchEvent: () => true,
    onModelContextChanged: () => {},
    onConversationInputRequested: () => {},
    subscribeEvents: () => undefined,
  });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  const resultSchema = z.object({
    tools: z.array(z.object({ name: z.string() })).optional(),
    resourceTemplates: z.array(z.object({ name: z.string() })).optional(),
    nextCursor: z.string().optional(),
  });
  try {
    for (cursor of ["", " ", " page-2 ", "page-2", "a+b/=✓\u00a0🦞"]) {
      for (const [method, gatewayMethod, items] of [
        ["tools/list", "mcp.app.listTools", "tools"],
        ["resources/templates/list", "mcp.app.listResourceTemplates", "resourceTemplates"],
      ] as const) {
        for (const params of [{}, { cursor: undefined }]) {
          const first = await app.request({ method, params }, resultSchema);
          expect(first[items]?.map((item) => item.name)).toEqual(["first"]);
          expect(first.nextCursor).toBe(cursor);
          expect(request).toHaveBeenLastCalledWith(gatewayMethod, {});
          const second = await app.request(
            { method, params: { cursor: first.nextCursor } },
            resultSchema,
          );
          expect(request).toHaveBeenLastCalledWith(gatewayMethod, { cursor });
          expect(second[items]?.map((item) => item.name)).toEqual(["second"]);
          expect(second.nextCursor).toBeUndefined();
        }
      }
    }
  } finally {
    await app.close();
    await bridge.close();
  }
});
