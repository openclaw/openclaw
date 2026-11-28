import { afterEach, expect, it, onTestFinished } from "vitest";
import { formatUserFacingAssistantErrorText } from "../agents/embedded-agent-helpers/error-text.js";
import { buildEmbeddedRunnerAssistant } from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "./chat-display-projection.core.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import {
  event,
  reports,
  runId,
  seed,
  target,
} from "./session-lifecycle-run-failure.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";

afterEach(() => clearRuntimeConfigSnapshot());

it.each(["assistant error", "lifecycle observation"] as const)(
  "keeps a code-only Responses policy refusal from the %s in live and reloaded chat",
  async (source) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      await seed("commentary");
      const raw = "Synthetic private provider diagnostic.";
      const summary =
        "The provider stopped this reply under its cybersecurity policy. Check any tool results first.";
      const errorData =
        source === "assistant error"
          ? {
              error: formatUserFacingAssistantErrorText(
                buildEmbeddedRunnerAssistant({
                  provider: "openai",
                  api: "openai-responses",
                  stopReason: "error",
                  errorCode: "cyber_policy",
                  errorType: "invalid_request",
                  errorMessage: raw,
                }),
              ),
            }
          : {
              error: raw,
              errorObservation: {
                provider: "openai",
                providerErrorCode: "cyber_policy",
                rawErrorPreview: raw,
                providerErrorMessagePreview: raw,
              },
            };
      let persistence: Promise<void> | undefined;
      const h = createAgentEventTestHarness({
        lifecycleErrorRetryGraceMs: 0,
        persistGatewaySessionLifecycleEventForEvent: (params) =>
          persistGatewaySessionLifecycleEvent({ ...params, ...target }),
        trackTrackedRunTerminalPersistence: (params) => {
          persistence = params.persistence;
        },
      });
      onTestFinished(() => h.handler.dispose());
      h.register(runId, target.sessionKey, runId, { agentId: target.agentId });
      await h.emit(
        runId,
        "lifecycle",
        { ...event.data, ...errorData },
        {
          ...target,
          seq: 2,
          ts: event.ts,
        },
      );
      await persistence;
      const live = h.chat().map(([, payload]) => payload);
      expect(live).toEqual([
        expect.objectContaining({ runId, state: "error", errorMessage: summary }),
      ]);
      const history = projectChatDisplayMessages(
        await readSessionMessagesAsync(target, { mode: "full", reason: "policy refusal" }),
      );
      expect(history.at(-1)).toMatchObject({
        openclawRunError: { runId, summary, summaryAsTitle: true },
      });
      expect(JSON.stringify([live, history])).not.toContain(raw);
      if (source === "lifecycle observation") {
        expect(await reports()).toEqual([
          expect.objectContaining({
            content: summary,
            details: expect.objectContaining({ error: raw }),
          }),
        ]);
      }
    });
  },
);
