/**
 * Resource Bridge Tests — Phase 4
 *
 * Tests for discovering and injecting MCP resources into agent context.
 * TDD: tests written first, then implementation.
 */

import { describe, it, expect, vi } from "vitest";
import type { McpClientBase } from "../client-base.js";
import { discoverResources, readResource, buildResourceContext } from "../resource-bridge.js";

// ─── Mock Client Factory ───

function createMockClient(overrides: Partial<McpClientBase> = {}): McpClientBase {
  return {
    name: "test-server",
    config: { resources: true },
    getStatus: () => "ready" as const,
    listResources: vi.fn().mockResolvedValue({
      resources: [
        {
          uri: "file:///readme.md",
          name: "readme",
          description: "Project readme",
          mimeType: "text/markdown",
        },
        {
          uri: "file:///config.json",
          name: "config",
          description: "Config file",
          mimeType: "application/json",
        },
      ],
    }),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ text: "# Hello World", mimeType: "text/markdown" }],
    }),
    ...overrides,
  } as unknown as McpClientBase;
}

// ─── Discovery Tests ───

describe("discoverResources", () => {
  it("discovers resources from mock server", async () => {
    const client = createMockClient();
    const resources = await discoverResources(client);
    expect(resources).toHaveLength(2);
    expect(resources[0].uri).toBe("file:///readme.md");
    expect(resources[0].name).toBe("readme");
    expect(resources[1].uri).toBe("file:///config.json");
  });

  it("filters resources by resourceFilter config", async () => {
    const client = createMockClient({
      config: { resources: true, resourceFilter: ["file:///readme.md"] },
    } as Partial<McpClientBase>);
    const resources = await discoverResources(client);
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("file:///readme.md");
  });

  it("empty filter returns all resources", async () => {
    const client = createMockClient({
      config: { resources: true, resourceFilter: [] },
    } as Partial<McpClientBase>);
    const resources = await discoverResources(client);
    expect(resources).toHaveLength(2);
  });

  it("returns empty array when resources disabled", async () => {
    const client = createMockClient({
      config: { resources: false },
    } as Partial<McpClientBase>);
    const resources = await discoverResources(client);
    expect(resources).toHaveLength(0);
    // listResources should not have been called
    const listFn = client.listResources;
    expect(listFn).not.toHaveBeenCalled();
  });
});

// ─── Read Tests ───

describe("readResource", () => {
  it("reads text resource and wraps as untrusted", async () => {
    const client = createMockClient();
    const result = await readResource(client, "test-server", {
      uri: "file:///readme.md",
      name: "readme",
    });
    expect(result).toContain("# Hello World");
    expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(result).toContain("MCP Server");
  });

  it("reads binary resource as placeholder text", async () => {
    const client = createMockClient({
      readResource: vi.fn().mockResolvedValue({
        contents: [{ blob: "aGVsbG8=", mimeType: "image/png" }],
      }),
    } as Partial<McpClientBase>);
    const result = await readResource(client, "test-server", {
      uri: "file:///logo.png",
      name: "logo",
    });
    expect(result).toContain("[Binary resource: image/png");
    expect(result).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  });

  it("handles resource read failure gracefully", async () => {
    const client = createMockClient({
      readResource: vi.fn().mockRejectedValue(new Error("not found")),
    } as Partial<McpClientBase>);
    const result = await readResource(client, "test-server", {
      uri: "file:///missing.md",
      name: "missing",
    });
    expect(result).toBeNull();
  });

  it("wraps resource content with EXTERNAL_UNTRUSTED_CONTENT markers", async () => {
    const client = createMockClient();
    const result = await readResource(client, "test-server", {
      uri: "file:///readme.md",
      name: "readme",
    });
    expect(result).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(result).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>");
  });
});

// ─── Context Building Tests ───

describe("buildResourceContext", () => {
  it("builds context block with header", async () => {
    const client = createMockClient();
    const context = await buildResourceContext(client, "test-server");
    expect(context).toContain("MCP Resources");
    expect(context).toContain("test-server");
    expect(context).toContain("# Hello World");
  });

  it("builds context block with multiple resources", async () => {
    const client = createMockClient({
      readResource: vi
        .fn()
        .mockResolvedValueOnce({ contents: [{ text: "Content A" }] })
        .mockResolvedValueOnce({ contents: [{ text: "Content B" }] }),
    } as Partial<McpClientBase>);
    const context = await buildResourceContext(client, "test-server");
    expect(context).toContain("Content A");
    expect(context).toContain("Content B");
  });

  it("empty resources returns empty string", async () => {
    const client = createMockClient({
      listResources: vi.fn().mockResolvedValue({ resources: [] }),
    } as Partial<McpClientBase>);
    const context = await buildResourceContext(client, "test-server");
    expect(context).toBe("");
  });

  it("handles resource read failure by skipping", async () => {
    const client = createMockClient({
      readResource: vi
        .fn()
        .mockResolvedValueOnce({ contents: [{ text: "Good content" }] })
        .mockRejectedValueOnce(new Error("fail")),
    } as Partial<McpClientBase>);
    const context = await buildResourceContext(client, "test-server");
    expect(context).toContain("Good content");
    // Should not throw, should skip the failed resource
  });
});
