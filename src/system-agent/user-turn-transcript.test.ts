import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { installModelPromptProjection } from "../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { SessionManager } from "../agents/sessions/index.js";
import { createSystemAgentUserTurnRecorder } from "./user-turn-transcript.js";

it("projects a detached system-agent prompt without requiring a durable admission", async () => {
  const recorder = createSystemAgentUserTurnRecorder("Check the configured model.");
  const manager = SessionManager.inMemory();
  const message = expectDefined(await recorder.resolveMessage(), "missing system-agent input");
  await manager.appendMessageAsync(message);
  recorder.markRuntimePersisted(message);
  const session: Parameters<typeof installModelPromptProjection>[0]["session"] = {
    agent: { state: { messages: [message] } },
  };
  const restore = installModelPromptProjection({
    session,
    transcriptPrompt: "Check the configured model.",
    modelPrompt: "Check the configured model. Reply OK.",
    shouldCapturePrompt: () => true,
    recorder,
  });
  try {
    const transform = expectDefined(session.agent.transformContext, "missing prompt transform");
    await expect(transform([message])).resolves.toMatchObject([
      {
        role: "user",
        __openclaw: {
          modelPromptProjection: { version: 1, text: "Check the configured model. Reply OK." },
        },
      },
    ]);
    expect(manager.getSessionTarget()).toBeUndefined();
    expect(manager.getEntries()).toMatchObject([
      { type: "message", message: { role: "user", content: "Check the configured model." } },
    ]);
    expect(message["__openclaw"]?.modelPromptProjection).toBeUndefined();
  } finally {
    restore();
  }
});
