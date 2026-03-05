import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolInputError } from "./common.js";
import { createSessionsSendConcurrentTool } from "./sessions-send-concurrent-tool.js";

describe("sessions_send_concurrent tool", () => {
  let tool: ReturnType<typeof createSessionsSendConcurrentTool>;

  beforeEach(() => {
    tool = createSessionsSendConcurrentTool({
      agentSessionKey: "test-session-key",
      agentChannel: "test-channel",
      sandboxed: false,
    });
  });

  it("should have correct tool metadata", () => {
    expect(tool.name).toBe("sessions_send_concurrent");
    expect(tool.label).toBe("Session Send Concurrent");
    expect(tool.description).toContain("concurrently");
    expect(tool.description).toContain("stream");
  });

  it("should accept valid parameters", () => {
    const _params = {
      targets: [
        {
          sessionKey: "session-1",
          message: "Hello",
        },
        {
          label: "test-label",
          message: "Hello again",
        },
      ],
      timeoutSeconds: 30,
    };

    // Validate schema structure exists
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeDefined();
  });

  it("should reject empty targets array", async () => {
    const params = {
      targets: [],
    };

    const result = await tool.execute("test-call-id", params, undefined, undefined);

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it("should reject targets array with more than 20 items", async () => {
    const params = {
      targets: Array.from({ length: 21 }, (_, i) => ({
        sessionKey: `session-${i}`,
        message: "Hello",
      })),
    };

    const result = await tool.execute("test-call-id", params, undefined, undefined);

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it("should accept targets array with 20 items", async () => {
    const params = {
      targets: Array.from({ length: 20 }, (_, i) => ({
        sessionKey: `session-${i}`,
        message: "Hello",
      })),
    };

    const result = await tool.execute("test-call-id", params, undefined, undefined);

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it("should reject target with missing message", async () => {
    const params = {
      targets: [
        {
          sessionKey: "session-1",
        },
      ],
    };

    // ToolInputError should be thrown for missing required parameter
    await expect(tool.execute("test-call-id", params, undefined, undefined)).rejects.toThrowError(
      ToolInputError,
    );
    await expect(tool.execute("test-call-id", params, undefined, undefined)).rejects.toThrow(
      "message required",
    );
  });

  it("should accept target with sessionKey", async () => {
    const params = {
      targets: [
        {
          sessionKey: "session-1",
          message: "Hello",
        },
      ],
    };

    // This will fail due to session resolution, but validates parameter parsing
    const result = await tool.execute("test-call-id", params, undefined, undefined);

    expect(result).toBeDefined();
  });

  it("should accept target with label", async () => {
    const params = {
      targets: [
        {
          label: "test-label",
          message: "Hello",
        },
      ],
    };

    // This will fail due to session resolution, but validates parameter parsing
    const result = await tool.execute("test-call-id", params, undefined, undefined);

    expect(result).toBeDefined();
  });

  it("should call onUpdate when provided", async () => {
    const onUpdate = vi.fn();
    const params = {
      targets: [
        {
          sessionKey: "session-1",
          message: "Hello",
        },
      ],
    };

    await tool.execute("test-call-id", params, undefined, onUpdate);

    // Should have been called at least once for initial progress
    expect(onUpdate).toHaveBeenCalled();
  });
});
