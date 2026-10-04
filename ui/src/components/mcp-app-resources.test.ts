import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { McpAppResources } from "./mcp-app-resources.ts";

afterEach(() => document.body.replaceChildren());

it("explains an unsupported mention result without exposing schema issues", async () => {
  const search = createDeferred<never>();
  const request = vi.fn(async (method: string) => {
    if (method === "mcp.app.mention") {
      return search.promise;
    }
    return {
      servers: [{ serverName: "parts", label: "Parts", entrypoints: [], mentionTool: "search" }],
    };
  });
  const element = new McpAppResources();
  element.sessionKey = "agent:main:main";
  element.agentId = "main";
  Reflect.set(element, "context", {
    gateway: {
      snapshot: {
        client: { request },
        phase: "connected",
        hello: { features: { methods: ["mcp.app.discover"] } },
      },
      connectionRevision: 1,
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
    agentSelection: { subscribe: () => () => {} },
  });
  document.body.append(element);
  await element.updateComplete;
  await element.updateComplete;
  element.querySelector<HTMLButtonElement>("button")!.click();
  await element.updateComplete;
  element.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  search.reject(
    Object.assign(new Error('[{"expected":"array","code":"invalid_type"}]'), {
      details: { code: "MCP_APP_UNSUPPORTED_MENTION_RESULT" },
    }),
  );
  await request.mock.results.at(-1)!.value.catch(() => {});
  await element.updateComplete;
  expect(request).toHaveBeenCalledWith("mcp.app.mention", {
    sessionKey: "agent:main:main",
    agentId: "main",
    serverName: "parts",
    query: "",
  });
  expect(element.querySelector('[role="alert"]')?.textContent).toBe(
    "This app returned an unsupported resource list",
  );
});
