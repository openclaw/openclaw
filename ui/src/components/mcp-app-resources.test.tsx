import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createApplicationGateway,
  createApplicationContextProvider,
} from "../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  MCP_APP_RESOURCE_MENTION_EVENT,
  type McpAppResourceMentionDetail,
} from "./mcp-app-resources.tsx";

function mountResources() {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const request = vi.spyOn(client, "request").mockResolvedValue({
    servers: [{ serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" }],
  });
  const gatewayControl = createApplicationGateway();
  const { gateway, publishEvent } = gatewayControl;
  gatewayControl.publish({
    ...gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  const context: Pick<ApplicationContext, "gateway" | "agentSelection"> = {
    gateway,
    agentSelection: createAgentSelectionCapability(gateway, {
      state: { agentsList: null },
      subscribe: () => () => {},
    }),
  };
  // SAFETY: This component only consumes the Gateway and agent selection capabilities.
  const container = createApplicationContextProvider(context as ApplicationContext);
  const picker = Object.assign(document.createElement("openclaw-mcp-app-resources"), {
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  container.append(picker);
  document.body.append(container);
  onTestFinished(() => container.remove());
  const setSessionKey = async (sessionKey: string) => {
    picker.sessionKey = sessionKey;
    await picker.updateComplete;
  };
  return { container, request, setSessionKey, publishEvent };
}

async function searchResources(container: HTMLElement) {
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  container.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}

it("explains an unsupported mention result without exposing schema issues", async () => {
  const { container, request } = mountResources();
  const search = createDeferred<never>();
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  request.mockReturnValueOnce(search.promise);
  await searchResources(container);
  search.reject(
    Object.assign(new Error('[{"expected":"array","code":"invalid_type"}]'), {
      details: { code: "MCP_APP_UNSUPPORTED_MENTION_RESULT" },
    }),
  );
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "This app returned an unsupported resource list",
    ),
  );
  expect(request).toHaveBeenCalledWith("mcp.app.mention", {
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "parts",
    query: "",
  });
});

it("only closes the resource picker when a consumer claims the selected resource", async () => {
  const { container, request } = mountResources();
  const resource = {
    type: "resource_link",
    uri: "file:///parts/gear.txt",
    name: "gear",
    title: "Gear",
    description: "A gear",
  } as const;
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  request.mockResolvedValueOnce({ resources: [resource] });
  await searchResources(container);
  await waitForSolid(() =>
    expect(container.querySelector(".mcp-app-resources__result")).not.toBeNull(),
  );
  const result = container.querySelector<HTMLButtonElement>(".mcp-app-resources__result")!;
  result.click();
  flush();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector("form")).not.toBeNull();
  let detail: McpAppResourceMentionDetail | undefined;
  container.addEventListener(MCP_APP_RESOURCE_MENTION_EVENT, (event) => {
    event.preventDefault();
    // SAFETY: The component emits this event with its exported detail contract.
    detail = (event as CustomEvent<McpAppResourceMentionDetail>).detail;
  });
  result.click();
  flush();
  expect(detail).toEqual({
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "parts",
    resource,
  });
  expect(container.querySelector("form")).toBeNull();
});

it("keeps resource ownership through discovery reorder and ignores previous-session results", async () => {
  const { container, request, setSessionKey, publishEvent } = mountResources();
  const resource = { type: "resource_link", uri: "file:///parts/gear.txt", name: "gear" } as const;
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  request.mockResolvedValueOnce({ resources: [resource] });
  await searchResources(container);
  await waitForSolid(() =>
    expect(container.querySelector(".mcp-app-resources__result")).not.toBeNull(),
  );
  request.mockResolvedValueOnce({
    servers: [
      { serverName: "ahead", label: "Ahead", entrypoints: [], mentionTool: "search" },
      { serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" },
    ],
  });
  publishEvent({ type: "event", event: "config.changed" });
  await waitForSolid(() => expect(container.querySelectorAll("option")).toHaveLength(2));
  let detail: McpAppResourceMentionDetail | undefined;
  container.addEventListener(MCP_APP_RESOURCE_MENTION_EVENT, (event) => {
    // SAFETY: The component emits this event with its exported detail contract.
    detail = (event as CustomEvent<McpAppResourceMentionDetail>).detail;
  });
  container.querySelector<HTMLButtonElement>(".mcp-app-resources__result")!.click();
  expect(detail).toEqual({
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "parts",
    resource,
  });
  expect(container.querySelector("select")?.value).toBe("parts");
  const pending = createDeferred<{
    resources: { type: "resource_link"; uri: string; name: string }[];
  }>();
  request.mockReturnValueOnce(pending.promise);
  container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await setSessionKey("agent:main:next");
  flush();
  pending.resolve({
    resources: [{ type: "resource_link", uri: "file:///old.txt", name: "Old resource" }],
  });
  await pending.promise;
  flush();
  expect(container.querySelector(".mcp-app-resources__result")).toBeNull();
  expect(container.textContent).not.toContain("Old resource");
});
