// Imported by agent.test.ts to share its suite-level mocked Gateway harness.
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  getAgentTestMocks,
  describe0AfterEach0,
  setupNewYorkTimeConfig,
  resetTimeConfig,
  primeMainAgentRun,
  invokeAgent,
  operatorWriteCliClient,
  waitForAgentCommandCall,
  expectRecordFields,
  expectRespondError,
} from "./agent.test-harness.js";
const mocks = getAgentTestMocks();
describe("gateway agent model-run contract", () => {
  afterEach(describe0AfterEach0);
  it("keeps model-run gateway prompts undecorated and forwards raw-run flags", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        provider: "ollama",
        model: "llama3.2:latest",
        modelRun: true,
        modelRunRequestedOverrides: { maxTokens: 64, temperature: 0 },
        promptMode: "none",
        sessionKey: "agent:main:main",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:discord:source",
          sourceTool: "sessions_send",
        },
        idempotencyKey: "test-model-run-raw",
      },
      {
        reqId: "model-run-raw",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      message?: string;
      modelRun?: boolean;
      streamParams?: { maxTokens?: number; temperature?: number };
      promptMode?: string;
    }>();
    expectRecordFields(callArgs, {
      message: "Reply exactly: pong",
      modelRun: true,
      promptMode: "none",
    });
    expect(callArgs.streamParams).toEqual({ maxTokens: 64, temperature: 0 });
    expect(callArgs.message).not.toContain("[Inter-session message]");

    resetTimeConfig();
  });

  it("rejects model-run generation settings outside model-run requests", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "unsafe settings",
        agentId: "main",
        sessionKey: "agent:main:main",
        modelRunRequestedOverrides: { maxTokens: 64, temperature: 0 },
        idempotencyKey: "test-model-run-options-without-model-run",
      },
      { reqId: "model-run-options-without-model-run", flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "modelRunRequestedOverrides requires modelRun=true.",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects promptMode none without the stateless model-run contract", async () => {
    primeMainAgentRun({ cfg: mocks.loadConfigReturn });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "unsafe raw run",
        agentId: "main",
        sessionKey: "agent:main:main",
        promptMode: "none",
        idempotencyKey: "test-raw-run-with-visible-session-effects",
      },
      { reqId: "raw-run-with-visible-session-effects", flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message:
        'promptMode="none" requires modelRun=true so the run cannot mutate a durable session.',
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });
});
