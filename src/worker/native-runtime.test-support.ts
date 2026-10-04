import { readFile } from "node:fs/promises";
import { createLlmRuntime } from "@openclaw/ai";
import { NativeRuntimeConfigSchema } from "./native-runtime-config.js";
import { createNativeRuntime } from "./native-runtime.js";
const config = NativeRuntimeConfigSchema.parse(
  JSON.parse(await readFile(process.argv[2]!, "utf8")),
);
const binding = {
  gatewayId: "gateway",
  workspaceId: "workspace",
  sessionId: "session",
  runId: "run",
  attemptId: "attempt",
  epoch: "epoch",
  connectionId: "connection",
};
const selection = { provider: "openai", modelId: "local-model" };
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
if (process.argv[3] === "snapshot") {
  const env = { NATIVE_TEST_KEY: process.env.NATIVE_TEST_KEY };
  const pending = createNativeRuntime(config, env);
  env.NATIVE_TEST_KEY = "changed-during-startup";
  config.models[0]!.baseUrl = "http://127.0.0.1:1/untrusted";
  config.models[0]!.headers!["x-startup"] = "changed";
  const runtime = await pending;
  process.env.OPENAI_API_KEY = "ambient-key";
  process.env.OPENAI_ORG_ID = "ambient-org";
  process.env.OPENAI_PROJECT_ID = "ambient-project";
  let hookCalled = false;
  const result = await runtime.withTurn({ binding, selection }, async (resolved) => {
    const stream = await resolved.streamFn(resolved.model, context, {
      apiKey: "wire-key",
      headers: { Authorization: "Bearer wire-key", "x-startup": "wire", "x-extra": "wire" },
      onPayload: () => {
        hookCalled = true;
        return { model: "injected" };
      },
      sessionId: "wire-session",
      temperature: 0.25,
    });
    const assistant = await stream.result();
    return {
      stopReason: assistant.stopReason,
      content: assistant.content,
      workspacePath: resolved.workspacePath,
      frozen: Object.isFrozen(resolved.model),
      hasModelHeaders: resolved.model.headers !== undefined,
    };
  });
  runtime.close();
  process.send?.({ ...result, hookCalled });
} else {
  const first = await createNativeRuntime(config, {
    NATIVE_TEST_KEY: process.env.NATIVE_FIRST_KEY,
  });
  const second = await createNativeRuntime(config, {
    NATIVE_TEST_KEY: process.env.NATIVE_SECOND_KEY,
  });
  createLlmRuntime().registry.clearApiProviders();
  const cwd = process.cwd();
  const run = (runtime: typeof first) =>
    runtime.withTurn({ binding, selection }, async (resolved) => {
      const stream = await resolved.streamFn(resolved.model, context);
      return (await stream.result()).stopReason;
    });
  const reasons = await Promise.all([run(first), run(second)]);
  first.close();
  reasons.push(await run(second));
  second.close();
  process.send?.({
    reasons,
    cwdUnchanged: process.cwd() === cwd,
    contextUnchanged: context.messages.length === 1,
  });
}
