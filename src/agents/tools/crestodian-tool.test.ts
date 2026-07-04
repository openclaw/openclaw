// Crestodian ring-zero tool tests: approval gating, action mapping, verification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrestodianTool } from "./crestodian-tool.js";

const mocks = vi.hoisted(() => ({
  executeCrestodianOperation: vi.fn(async (_op: unknown, runtime: { log: (m: string) => void }) => {
    runtime.log("op-output");
    return { applied: false };
  }),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
}));

vi.mock("../../crestodian/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../crestodian/operations.js")>()),
  executeCrestodianOperation: mocks.executeCrestodianOperation,
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

describe("crestodian tool", () => {
  it("runs read actions immediately", async () => {
    const tool = createCrestodianTool({ surface: "cli" });
    const result = await tool.execute("t1", { action: "status" });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "status" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );
  });

  it("refuses mutating actions without the approved assertion", async () => {
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true });
    const result = await tool.execute("t2", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("refuses model-asserted approval without host-verified consent", async () => {
    // approved=true from the model alone must never mutate: the host arms
    // approval only when the user's actual message was an explicit yes.
    const tool = createCrestodianTool({ surface: "cli" });
    const result = await tool.execute("t2b", {
      action: "config_set",
      path: "gateway.port",
      value: "18789",
      approved: true,
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(mocks.executeCrestodianOperation).not.toHaveBeenCalled();
  });

  it("executes approved mutations through the typed operation with audit provenance", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    const tool = createCrestodianTool({ surface: "gateway", approvalArmed: true });
    const result = await tool.execute("t3", {
      action: "set_default_model",
      model: "openai/gpt-5.5",
      approved: true,
    });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      expect.anything(),
      expect.objectContaining({
        approved: true,
        deps: { setupSurface: "gateway" },
        auditDetails: { via: "crestodian-agent-tool" },
      }),
    );
  });

  it("feeds config validation failures back into the tool result", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number" }],
    } as never);
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true });
    const result = await tool.execute("t4", {
      action: "config_set",
      path: "gateway.port",
      value: "banana",
      approved: true,
    });
    const text = toolText(result);
    expect(text).toContain("CONFIG INVALID");
    expect(text).toContain("gateway.port: Expected number");
  });

  it("maps create_agent with optional workspace and model", async () => {
    mocks.executeCrestodianOperation.mockImplementationOnce(
      async (_op: unknown, runtime: { log: (m: string) => void }) => {
        runtime.log("op-output");
        return { applied: true };
      },
    );
    const tool = createCrestodianTool({ surface: "cli", approvalArmed: true });
    await tool.execute("t6", {
      action: "create_agent",
      agentId: "work",
      workspace: "/tmp/work",
      approved: true,
    });
    expect(mocks.executeCrestodianOperation).toHaveBeenCalledWith(
      { kind: "create-agent", agentId: "work", workspace: "/tmp/work" },
      expect.anything(),
      expect.objectContaining({ approved: true }),
    );
  });

  it("rejects unknown or underspecified actions as input errors", async () => {
    const tool = createCrestodianTool({ surface: "cli" });
    await expect(tool.execute("t5", { action: "config_get" })).rejects.toThrow(/path/);
  });
});
