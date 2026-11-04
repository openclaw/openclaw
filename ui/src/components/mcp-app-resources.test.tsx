import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  MCP_APP_RESOURCE_MENTION_EVENT,
  type McpAppResourceMentionDetail,
} from "./mcp-app-resource-mention.ts";
import { McpAppResources } from "./mcp-app-resources.tsx";

function mountResources(
  servers: McpAppDiscoverResult["servers"] = [
    { serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" },
  ],
) {
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const request = vi.spyOn(client, "request").mockResolvedValue({ servers });
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
  const [sessionKey, updateSessionKey] = createSignal("agent:main:main");
  // SAFETY: This component only consumes the Gateway and agent selection capabilities.
  const { container } = mountSolid(
    () => <McpAppResources sessionKey={sessionKey()} agentId="main" />,
    { wrapper: createSolidApplicationContextProvider(context as ApplicationContext).wrapper },
  );
  const setSessionKey = (value: string) => {
    updateSessionKey(value);
    flush();
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
    expect(event.target).toBe(container.querySelector("openclaw-mcp-app-resources"));
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
  expect(structuredClone(detail)).toEqual(detail);
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
  setSessionKey("agent:main:next");
  flush();
  pending.resolve({
    resources: [{ type: "resource_link", uri: "file:///old.txt", name: "Old resource" }],
  });
  await pending.promise;
  flush();
  expect(container.querySelector(".mcp-app-resources__result")).toBeNull();
  expect(container.textContent).not.toContain("Old resource");
});

it("submits native query and server changes made before presentation settles", async () => {
  const { container, request } = mountResources([
    { serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" },
    { serverName: "manuals", label: "Manuals", entrypoints: [], mentionTool: "search" },
  ]);
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  container.querySelector<HTMLButtonElement>("button")!.click();
  flush();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const select = container.querySelector("select")!;
  request.mockResolvedValueOnce({ resources: [] });

  input.value = "brass gear";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  select.value = "manuals";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

  expect(request).toHaveBeenLastCalledWith("mcp.app.mention", {
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "manuals",
    query: "brass gear",
  });
  await waitForSolid(() => expect(container.querySelector('[role="status"]')).not.toBeNull());
});

it.each(["query", "server"])(
  "rejects a retained resource button after a %s edit before rendering",
  async (edit) => {
    const { container, request } = mountResources([
      { serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" },
      { serverName: "manuals", label: "Manuals", entrypoints: [], mentionTool: "search" },
    ]);
    const resource = {
      type: "resource_link",
      uri: "file:///parts/gear.txt",
      name: "gear",
    } as const;
    await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
    request.mockResolvedValueOnce({ resources: [resource] });
    await searchResources(container);
    await waitForSolid(() =>
      expect(container.querySelector(".mcp-app-resources__result")).not.toBeNull(),
    );
    const retained = container.querySelector<HTMLButtonElement>(".mcp-app-resources__result")!;
    const mention = vi.fn((event: Event) => event.preventDefault());
    container.addEventListener(MCP_APP_RESOURCE_MENTION_EVENT, mention);

    if (edit === "query") {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = "updated query";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const select = container.querySelector("select")!;
      select.value = "manuals";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    retained.click();

    expect(mention).not.toHaveBeenCalled();
    flush();
    expect(container.querySelector(".mcp-app-resources__result")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  },
);

it("retires a pending search across an empty intermediate session and return", async () => {
  const { container, request, setSessionKey } = mountResources();
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  const pending = createDeferred<{
    resources: { type: "resource_link"; uri: string; name: string }[];
  }>();
  request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ servers: [] });
  await searchResources(container);
  expect(request).toHaveBeenCalledWith("mcp.app.mention", {
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "parts",
    query: "",
  });

  setSessionKey("agent:main:other");
  await waitForSolid(() => expect(container.querySelector(".mcp-app-resources")).toBeNull());
  // The hidden picker has no presentation consumer during this committed identity.
  setSessionKey("agent:main:main");
  await waitForSolid(() => expect(container.querySelector("form")).not.toBeNull());
  pending.resolve({
    resources: [{ type: "resource_link", uri: "file:///old.txt", name: "Retired result" }],
  });
  await pending.promise;
  flush();

  expect(container.querySelector(".mcp-app-resources__result")).toBeNull();
  expect(container.textContent).not.toContain("Retired result");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("keeps pending resource searches editable and resumes them after collapse", async () => {
  const { container, request } = mountResources();
  const pending = createDeferred<{
    resources: { type: "resource_link"; uri: string; name: string }[];
  }>();
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  request.mockReturnValueOnce(pending.promise);
  await searchResources(container);
  flush();

  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(input.disabled).toBe(false);
  expect(container.querySelector("select")?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  const toggle = container.querySelector<HTMLButtonElement>("button")!;
  toggle.click();
  flush();
  expect(container.querySelector("form")).toBeNull();
  toggle.click();
  flush();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

  pending.resolve({
    resources: [{ type: "resource_link", uri: "file:///parts/gear.txt", name: "Gear" }],
  });
  await waitForSolid(() =>
    expect(container.querySelector(".mcp-app-resources__result")?.textContent).toContain("Gear"),
  );
  expect(container.querySelector("select")?.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === "mcp.app.mention")).toHaveLength(1);
});

it("retains resource errors through edits and collapse but clears them during retry", async () => {
  const { container, request } = mountResources([
    { serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" },
    { serverName: "manuals", label: "Manuals", entrypoints: [], mentionTool: "search" },
  ]);
  const first = createDeferred<never>();
  await waitForSolid(() => expect(container.querySelector("button")).not.toBeNull());
  request.mockReturnValueOnce(first.promise);
  await searchResources(container);
  first.reject(new Error("Resource unavailable"));
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Resource unavailable",
    ),
  );
  const message = container.querySelector('[role="alert"]')!.textContent;
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.value = "brass gear";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  const select = container.querySelector("select")!;
  select.value = "manuals";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);

  const toggle = container.querySelector<HTMLButtonElement>("button")!;
  toggle.click();
  flush();
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  toggle.click();
  flush();
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(
    "brass gear",
  );
  const retryInput = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const retry = createDeferred<{ resources: [] }>();
  request.mockReturnValueOnce(retry.promise);
  container.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(request).toHaveBeenLastCalledWith("mcp.app.mention", {
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "manuals",
    query: "brass gear",
  });
  flush();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')).toBe(retryInput);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  retry.resolve({ resources: [] });
  await waitForSolid(() => expect(container.querySelector('[role="status"]')).not.toBeNull());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});
