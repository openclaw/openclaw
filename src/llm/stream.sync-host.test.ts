import "../test-utils/prepare-compiled-subprocesses.js";
import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type { StreamFunction } from "@openclaw/llm-core";
import { expect, it, vi } from "vitest";
import { formatUserFacingAssistantErrorText } from "../agents/embedded-agent-helpers/error-text.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { decodePostgresError } from "../infra/postgres-sync/protocol.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-error.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { stream, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

it("defers provider streams until runtime transport ports are installed", async () => {
  const registry = createApiRegistry();
  const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
  const model = makeProviderModelFixture({
    api: "test-sync-runtime-host-api",
    provider: "test-sync-runtime-host",
    id: "test-sync-runtime-host-model",
    baseUrl: "https://example.test",
  });
  const message = makeAgentAssistantMessage({
    content: [{ type: "text", text: "configured" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
  });
  const providerStream = vi.fn<StreamFunction>(() => {
    expect(getAiTransportHost().plugin.wrapSimpleCompletionStream).not.toBe(inertWrapper);
    const output = createAssistantMessageEventStream();
    output.push({ type: "done", reason: "stop", message });
    output.end();
    return output;
  });
  registry.registerApiProvider({
    api: model.api,
    stream: providerStream,
    streamSimple: providerStream,
  });
  const boundModel = bindModelLlmRuntime(model, createLlmRuntime(registry));
  const fail = (error: Error) => {
    providerStream.mockImplementation(() => {
      throw error;
    });
    return stream(boundModel, { messages: [] }).result();
  };

  const outputs = [
    stream(boundModel, { messages: [] }),
    streamSimple(boundModel, { messages: [] }),
  ];
  expect(providerStream).not.toHaveBeenCalled();

  await expect(Promise.all(outputs.map((output) => output.result()))).resolves.toEqual([
    message,
    message,
  ]);

  const busy = Object.assign(new Error("private native detail"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  await expect(fail(busy)).resolves.toMatchObject({
    stopReason: "error",
    errorCode: "SQLITE_BUSY",
    errorMessage: "private native detail",
  });

  const canceled = new Error("Outer runtime failure", {
    cause: decodePostgresError({
      name: "error",
      message: "canceling statement due to user request PRIVATE_STORAGE_DETAIL",
      code: "57014",
    }),
  });
  await expect(fail(canceled)).resolves.toMatchObject({
    stopReason: "error",
    errorCode: "57014",
    errorType: "PostgresQueryCanceledError",
  });
  const rollback = new SqliteWorkerError("private rollback detail", "unavailable");
  const failure = await fail(rollback);
  expect(failure).toMatchObject({ errorCode: "unavailable", errorType: "SqliteWorkerError" });
  expect(formatUserFacingAssistantErrorText(failure)).toMatch(/rolled back/i);
  expect(formatUserFacingAssistantErrorText(failure)).toMatch(/retry/i);
  const uncertain = await fail(
    new AggregateError(
      [rollback, new SqliteWorkerError("private settlement detail", "outcome-unknown")],
      "private cleanup detail",
      { cause: rollback },
    ),
  );
  expect(uncertain.errorCode).toBe("session_actor_reconciliation");
  expect(formatUserFacingAssistantErrorText(uncertain)).toMatch(/check.*history/i);

  await expect(
    fail(Object.assign(new Error("provider capacity failure"), { code: "unavailable" })),
  ).resolves.toMatchObject({ errorCode: undefined, errorType: undefined });
});
