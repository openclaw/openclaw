import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { WorkSnapshot } from "../../session-cards/progress-card-work-intent.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as gateway from "./in-process-gateway.js";
import { createProgressCardTool } from "./progress-card-tool.js";

afterEach(() => vi.restoreAllMocks());

describe("progress_card tool", () => {
  it("replaces the card and returns compact progress receipts", async () => {
    const steps = [
      { step: "Inspect", status: "completed" as const },
      { step: "Patch", status: "in_progress" as const },
      { step: "Verify", status: "pending" as const },
    ];
    const callGateway = vi
      .spyOn(gateway, "callInProcessGatewayTool")
      .mockResolvedValueOnce({
        card: {
          sessionKey: "agent:main:main",
          markdown: "Implementation underway",
          steps,
          revision: 3,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        card: {
          sessionKey: "agent:main:main",
          markdown: "A note",
          revision: 4,
          updatedAt: 2,
        },
      })
      .mockResolvedValueOnce({ card: null });
    const savedPlans: string[] = [];
    const tool = createProgressCardTool({
      agentSessionKey: "agent:main:main",
      onWorkSaved: (snapshot) => savedPlans.push(snapshot.kind),
    });

    expect(tool.requiredClientCaps).toBeUndefined();
    const planned = await tool.execute("call-1", {
      markdown: "Implementation underway",
      plan: steps,
    });
    expect(callGateway).toHaveBeenNthCalledWith(1, "progressCard.put", {
      sessionKey: "agent:main:main",
      markdown: "Implementation underway",
      plan: steps,
    });
    expect(planned.details).toEqual({ revision: 3, steps: { completed: 1, total: 3 } });
    expect(planned.content[0]).toEqual({
      type: "text",
      text: "Progress card updated (rev 3, 1/3 done)",
    });

    const note = await tool.execute("call-2", { markdown: "A note" });
    expect(note.details).toEqual({ revision: 4, steps: null });
    expect(note.content[0]).toEqual({ type: "text", text: "Progress card updated (rev 4)" });

    const cleared = await tool.execute("call-3", {});
    expect(callGateway).toHaveBeenNthCalledWith(3, "progressCard.put", {
      sessionKey: "agent:main:main",
    });
    expect(cleared.details).toEqual({ revision: null, steps: null });
    expect(cleared.content[0]).toEqual({ type: "text", text: "Progress card cleared" });
    expect(savedPlans).toEqual(["unavailable", "unavailable", "unavailable"]);

    callGateway.mockRejectedValueOnce(new Error("save rejected"));
    await expect(tool.execute("call-failed", { plan: steps })).rejects.toThrow("save rejected");
    expect(savedPlans).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  it.each([
    {
      name: "multiple active steps",
      args: {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      },
      message: "at most one in_progress",
    },
    {
      name: "too many steps",
      args: {
        plan: Array.from({ length: 51 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: "at most 50 steps",
    },
    {
      name: "empty step",
      args: { plan: [{ step: " \u200b ", status: "pending" }] },
      message: "must not be empty",
    },
    {
      name: "oversized step",
      args: { plan: [{ step: "é".repeat(257), status: "pending" }] },
      message: "512 UTF-8 bytes",
    },
    {
      name: "oversized markdown",
      args: { markdown: "é".repeat(4097) },
      message: "8192 UTF-8 bytes",
    },
  ])("rejects $name before writing", async ({ args, message }) => {
    const callGateway = vi.spyOn(gateway, "callInProcessGatewayTool");
    const tool = createProgressCardTool({ agentSessionKey: "agent:main:main" });

    await expect(tool.execute("call-invalid", args)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails before calling the gateway without a session", async () => {
    const callGateway = vi.spyOn(gateway, "callInProcessGatewayTool");
    const tool = createProgressCardTool();

    await expect(tool.execute("call-1", { markdown: "Working" })).rejects.toMatchObject({
      name: "ToolInputError",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps the bound global owner when model arguments name another session", async () => {
    const callGateway = vi
      .spyOn(gateway, "callInProcessGatewayTool")
      .mockResolvedValue({ card: null });
    const options = { agentSessionKey: "global", agentId: "research" };
    const tool = createProgressCardTool(options);

    await tool.execute("call-owner", { sessionKey: "agent:main:main", agentId: "main" });

    expect(callGateway).toHaveBeenCalledWith("progressCard.put", {
      sessionKey: "global",
      agentId: "research",
    });
    expect(tool.parameters).not.toHaveProperty("properties.agentId");
    expect(tool.parameters).not.toHaveProperty("properties.sessionKey");
  });
});

it("captures the host fence before dispatch and rejects stale or failed callbacks without fallback", async () => {
  const owner = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "current",
    lifecycleRevision: null,
  };
  let current: WorkSnapshot = { kind: "none" };
  const callback = vi.fn((value: WorkSnapshot) => {
    current = value;
  });
  const tool = createProgressCardTool({
    agentSessionKey: owner.sessionKey,
    workOwner: owner,
    workTarget: captureSessionTranscriptTargetBinding({
      ...owner,
      storePath: "/private/test.sqlite",
    }),
    readWork: () => current,
    onWorkSaved: callback,
  });
  const call = vi.spyOn(gateway, "callAgentToolGatewayRequest");
  const fallback = vi.spyOn(gateway, "callInProcessGatewayTool");
  const args = {
    work: { action: "begin", scope: "Task" },
    plan: [{ step: "Finish", status: "pending" }],
  };
  const invoke = () =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: owner.sessionKey,
        operationalRunInstance: { runId: "current-run", instanceId: "instance" },
        receiptAuthority: () => true,
      },
      () =>
        runWithAgentToolExecutionContext(
          {
            assistantMessage: makeAgentAssistantMessage({ turnId: "turn", content: [] }),
            toolCall: { type: "toolCall", id: "save", name: "progress_card", arguments: args },
          },
          () => tool.execute("save", args),
        ),
    );
  call.mockImplementationOnce(async (request) => {
    expect(request.agentToolCaller?.progressWork?.expected).toBeNull();
    current = { kind: "retained", state: { generation: 2, revision: 2, record: null } };
    return {
      card: null,
      work: { kind: "retained", state: { generation: 1, revision: 1, record: null } },
    };
  });
  await expect(invoke()).rejects.toThrow("superseded");
  expect(callback).not.toHaveBeenCalled();
  expect(current).toMatchObject({ state: { generation: 2, revision: 2 } });
  call.mockRejectedValueOnce(new Error("uncertain save"));
  await expect(invoke()).rejects.toThrow("uncertain save");
  expect(callback).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});
