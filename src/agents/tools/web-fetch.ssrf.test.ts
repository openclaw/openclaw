import { describe, expect, it } from "vitest";

// Import the internal functions we want to test
// We'll test by trying to access the module and checking behavior

describe("web-fetch SSRF protection", () => {
  // Test the URL validation logic directly by importing the module
  // and checking that blocked URLs throw errors

  it("should block localhost URLs", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(tool.execute("test-call", { url: "http://localhost/test" })).rejects.toThrow(
        /Blocked hostname/,
      );
    }
  });

  it("should block 127.0.0.1 URLs", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(tool.execute("test-call", { url: "http://127.0.0.1/test" })).rejects.toThrow(
        /private|internal|Blocked/i,
      );
    }
  });

  it("should block metadata service IP (169.254.169.254)", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(
        tool.execute("test-call", {
          url: "http://169.254.169.254/latest/meta-data/",
        }),
      ).rejects.toThrow(/private|internal|Blocked/i);
    }
  });

  it("should block .internal hostnames", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(
        tool.execute("test-call", { url: "http://something.internal/test" }),
      ).rejects.toThrow(/Blocked hostname/);
    }
  });

  it("should block metadata.google.internal", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(
        tool.execute("test-call", {
          url: "http://metadata.google.internal/computeMetadata/v1/",
        }),
      ).rejects.toThrow(/Blocked hostname/);
    }
  });

  it("should block private IP ranges (10.x.x.x)", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(tool.execute("test-call", { url: "http://10.0.0.1/admin" })).rejects.toThrow(
        /private|internal|Blocked/i,
      );
    }
  });

  it("should block private IP ranges (192.168.x.x)", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(tool.execute("test-call", { url: "http://192.168.1.1/admin" })).rejects.toThrow(
        /private|internal|Blocked/i,
      );
    }
  });

  it("should block private IP ranges (172.16-31.x.x)", async () => {
    const { createWebFetchTool } = await import("./web-fetch.js");
    const tool = createWebFetchTool();
    expect(tool).not.toBeNull();

    if (tool) {
      await expect(tool.execute("test-call", { url: "http://172.16.0.1/admin" })).rejects.toThrow(
        /private|internal|Blocked/i,
      );
    }
  });
});
