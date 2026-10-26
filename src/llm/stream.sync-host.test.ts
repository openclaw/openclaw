import "../test-utils/prepare-compiled-subprocesses.js";
import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { formatUserFacingAssistantErrorText } from "../agents/embedded-agent-helpers/error-text.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import {
  classifyGatewayStorageFailure,
  isLocalStorageOutcomeError,
} from "../infra/sqlite-error-diagnostics.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-error.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { stream, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";
import { isRetryableAssistantError } from "./utils/retry.js";

describe("LLM synchronous stream transport host", () => {
  it("defers provider streams until runtime transport ports are installed", async () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
    const model = makeProviderModelFixture({
      api: "test-sync-runtime-host-api",
      provider: "test-sync-runtime-host",
      id: "test-sync-runtime-host-model",
      name: "Test Sync Runtime Host Model",
      baseUrl: "https://example.test",
      contextWindow: 1024,
      maxTokens: 512,
    });
    const message: AssistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "configured" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
    });
    const providerStream = vi.fn(
      (runtimeModel: Model, context: Context): AssistantMessageEventStreamContract => {
        expect(getAiTransportHost().plugin.wrapSimpleCompletionStream).not.toBe(inertWrapper);
        expect(context.messages).toEqual([]);
        expect(runtimeModel.id).toBe(model.id);
        const output = createAssistantMessageEventStream();
        output.push({ type: "done", reason: "stop", message });
        output.end();
        return output;
      },
    );
    registry.registerApiProvider({
      api: model.api,
      stream: providerStream,
      streamSimple: providerStream,
    });
    const boundModel = bindModelLlmRuntime(model, runtime);

    const outputs = [
      stream(boundModel, { messages: [] }),
      streamSimple(boundModel, { messages: [] }),
    ];
    expect(providerStream).not.toHaveBeenCalled();

    await expect(Promise.all(outputs.map((output) => output.result()))).resolves.toEqual([
      message,
      message,
    ]);
    expect(providerStream).toHaveBeenCalledTimes(2);

    providerStream.mockImplementation(() => {
      throw Object.assign(new Error("private native detail"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
    });
    await expect(stream(boundModel, { messages: [] }).result()).resolves.toMatchObject({
      stopReason: "error",
      errorCode: "SQLITE_BUSY",
      errorMessage: "private native detail",
    });

    providerStream.mockImplementation(() => {
      throw new Error("Outer runtime failure", {
        cause: decodePostgresError({
          name: "error",
          message: "canceling statement due to user request PRIVATE_STORAGE_DETAIL",
          code: "57014",
        }),
      });
    });
    for (const run of [stream, streamSimple]) {
      const failure = await run(boundModel, { messages: [] }).result();
      expect(failure).toMatchObject({
        stopReason: "error",
        errorCode: "57014",
        errorType: "PostgresQueryCanceledError",
      });
      expect(classifyGatewayStorageFailure(failure)).toBe("57014");
    }
    providerStream.mockImplementation(() => {
      throw new SqliteWorkerError("private rollback detail", "unavailable");
    });
    for (const run of [stream, streamSimple]) {
      const failure = await run(boundModel, { messages: [] }).result();
      expect(classifyGatewayStorageFailure(failure)).toBe("unavailable");
      expect(isLocalStorageOutcomeError(failure)).toBe(false);
      expect(formatUserFacingAssistantErrorText(failure)).toMatch(/rolled back/i);
      expect(formatUserFacingAssistantErrorText(failure)).toMatch(/retry/i);
      const providerFailure = { ...failure, errorType: undefined };
      expect(classifyGatewayStorageFailure(providerFailure)).toBeUndefined();
      expect(isRetryableAssistantError(failure)).toBe(isRetryableAssistantError(providerFailure));
    }
    const rollback = new SqliteWorkerError("private rollback detail", "unavailable");
    providerStream.mockImplementation(() => {
      throw new AggregateError(
        [rollback, new SqliteWorkerError("private settlement detail", "outcome-unknown")],
        "private cleanup detail",
        { cause: rollback },
      );
    });
    const uncertain = await stream(boundModel, { messages: [] }).result();
    expect(classifyGatewayStorageFailure(uncertain)).toBe("session_actor_reconciliation");
    expect(isLocalStorageOutcomeError(uncertain)).toBe(true);
    expect(isRetryableAssistantError(uncertain)).toBe(false);
    expect(formatUserFacingAssistantErrorText(uncertain)).toMatch(/check.*history/i);

    providerStream.mockImplementation(() => {
      throw Object.assign(new Error("provider capacity failure"), { code: "unavailable" });
    });
    expect(
      classifyGatewayStorageFailure(await stream(boundModel, { messages: [] }).result()),
    ).toBeUndefined();
  });
});
