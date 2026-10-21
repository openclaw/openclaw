import { expect, it } from "vitest";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

it("enables network web tools by default outside the sandbox", () => {
  const options = { config: {}, sandboxed: false };
  expect(createWebFetchTool(options)).toMatchObject({
    name: "web_fetch",
    resultContentSource: "network",
  });
  expect(createWebSearchTool(options)?.resultContentSource).toBe("network");
});

it("disables web_fetch when explicitly disabled", () => {
  expect(
    createWebFetchTool({
      config: { tools: { web: { fetch: { enabled: false } } } },
      sandboxed: false,
    }),
  ).toBeNull();
});
