import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { StructuredInputCapability } from "../harness/structured-input-execution.js";
import { normalizeAskUserParams } from "./ask-user-tool-normalization.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { ToolInputError } from "./common.js";

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

function capability(request: StructuredInputCapability["request"]): StructuredInputCapability {
  return {
    request,
    blockingDeadlineMs: () => undefined,
    onBlockingDeadlineChange: () => () => undefined,
    close: vi.fn(),
  };
}

describe("ask_user", () => {
  it("keeps normalization and schema validation at the tool boundary", () => {
    const normalized = normalizeAskUserParams({ ...validArgs, timeoutSeconds: 5 });

    expect(normalized.timeoutSeconds).toBe(30);
    expect(normalized.questions[0]).toMatchObject({
      questionId: "deploy_target",
      header: "Deployment t",
      isOther: true,
    });
    expect(normalizeAskUserParams({ ...validArgs, timeoutSeconds: 9_999 }).timeoutSeconds).toBe(
      3_600,
    );
    expect(Value.Check(createAskUserTool({}).parameters, validArgs)).toBe(true);
  });

  it("fails visibly before registration when host authority is missing", async () => {
    await expect(createAskUserTool({}).execute("call-1", validArgs)).rejects.toEqual(
      expect.objectContaining({
        constructor: ToolInputError,
        message: expect.stringContaining("no structured input capability"),
      }),
    );
  });

  it("normalizes then delegates the exact tool call id to the host capability", async () => {
    const request = vi.fn<StructuredInputCapability["request"]>(async () => ({
      status: "answered",
      answers: { deploy_target: ["Staging (Recommended)"] },
      content: { deploy_target: "Staging (Recommended)" },
    }));

    const result = await createAskUserTool({
      structuredInputCapability: capability(request),
    }).execute("mcp-123", { ...validArgs, timeoutSeconds: 3_600 });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "mcp-123", timeoutMs: 3_600_000 }),
    );
    const input = request.mock.calls[0]?.[0].input;
    expect(input).toMatchObject({
      kind: "ready",
      plan: {
        kind: "form",
        fields: [
          {
            question: expect.objectContaining({
              id: "deploy_target",
              isOther: true,
              isSecret: false,
            }),
          },
        ],
      },
    });
    expect(result).toMatchObject({
      details: {
        status: "answered",
        answers: { answers: { deploy_target: ["Staging (Recommended)"] } },
      },
    });
  });

  it("maps cancellation to a visible no-answer result", async () => {
    const result = await createAskUserTool({
      structuredInputCapability: capability(async () => ({ status: "cancelled" })),
    }).execute("call-cancel", validArgs);

    expect(result).toMatchObject({ details: { status: "no_answer" } });
  });

  it("surfaces concurrent input admission failures", async () => {
    const tool = createAskUserTool({
      structuredInputCapability: capability(async () => {
        throw new Error("session already has a pending agent input request");
      }),
    });

    await expect(tool.execute("call-concurrent", validArgs)).rejects.toThrow(
      "session already has a pending agent input request",
    );
  });
});
