import { describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ feature: { verbose: false } })),
  writeConfigFile: vi.fn(async () => undefined),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: configMock.loadConfig,
  writeConfigFile: configMock.writeConfigFile,
}));

describe("claw compat tools", () => {
  it("supports sleep duration_ms and enforces max duration", async () => {
    const { createSleepCompatTool } = await import("./claw-compat-tools.js");
    const tool = createSleepCompatTool();
    const result = await tool.execute("tool-1", { duration_ms: 0 });
    expect(result).toMatchObject({ details: { status: "ok", sleptMs: 0 } });
    await expect(tool.execute("tool-2", { duration_ms: 300_001 })).rejects.toThrow(
      "exceeds maximum allowed sleep",
    );
  });

  it("maps tool_search max_results and returns limited results", async () => {
    const { createToolSearchCompatTool } = await import("./claw-compat-tools.js");
    const tool = createToolSearchCompatTool();
    const result = await tool.execute("tool-3", { query: "task", max_results: 1 });
    expect(result).toMatchObject({
      details: {
        status: "ok",
        query: "task",
        tools: expect.any(Array),
      },
    });
    expect((result as { details: { tools: unknown[] } }).details.tools.length).toBeLessThanOrEqual(1);
  });

  it("supports config setting get/set payloads", async () => {
    const { createConfigCompatTool } = await import("./claw-compat-tools.js");
    const tool = createConfigCompatTool();

    const getResult = await tool.execute("tool-4", { setting: "feature.verbose" });
    expect(getResult).toMatchObject({
      details: {
        success: true,
        operation: "get",
        setting: "feature.verbose",
        value: false,
      },
    });

    const setResult = await tool.execute("tool-5", { setting: "feature.verbose", value: true });
    expect(setResult).toMatchObject({
      details: {
        success: true,
        operation: "set",
        setting: "feature.verbose",
        value: true,
      },
    });
    expect(configMock.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("sends RemoteTrigger string body without JSON quoting", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "ok",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { createRemoteTriggerCompatTool } = await import("./claw-compat-tools.js");
      const tool = createRemoteTriggerCompatTool();
      await tool.execute("tool-6", {
        url: "https://example.com/webhook",
        method: "POST",
        body: "plain-body",
      });
      const call = fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
      expect(call?.body).toBe("plain-body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns testing_permission compat payload", async () => {
    const { createTestingPermissionCompatTool } = await import("./claw-compat-tools.js");
    const tool = createTestingPermissionCompatTool();
    const result = await tool.execute("tool-7", { action: "probe" });
    expect(result).toMatchObject({
      details: {
        action: "probe",
        permitted: true,
      },
    });
  });
});
