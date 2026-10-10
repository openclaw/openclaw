import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import * as embeddedRuns from "../../../agents/embedded-agent-runner/runs.js";
import {
  createAssistant,
  createTestSession,
  streamMocks,
  testModel,
} from "../../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "../../../agents/sessions/agent-session.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  connectNativeSession,
  withNativePlugin,
  withParkedNativeTask,
} from "./client-native-control.test-support.js";

export async function prepareMissingRegistrationFixture() {
  const { session } = await createTestSession();
  const providerStream = createAssistantMessageEventStream();
  const answer = createAssistant(testModel, [{ type: "text", text: "Task finished." }]);
  const finish = vi.fn(() => {
    providerStream.push({ type: "done", reason: "stop", message: answer });
    providerStream.end();
  });
  streamMocks.streamSimple.mockImplementation(() => providerStream);
  const publish = vi.spyOn(embeddedRuns, "setActiveEmbeddedRun").mockImplementation(() => {});
  const assertions = vi.fn(async () => {});
  const prepared = await prepareParkedNativeTask(
    assertions,
    "Keep working until I cancel.",
    session,
    finish,
  );
  return { session, providerStream, answer, finish, publish, assertions, ...prepared };
}

/** Lease setup and teardown separately from a parked task's readiness deadline. */
async function prepareParkedNativeTask(
  run: Parameters<typeof withParkedNativeTask>[0],
  prompt: string,
  session: AgentSession,
  finish: () => void,
) {
  const ready = createDeferredCore<() => Promise<void>>();
  const release = createDeferredCore();
  let running: Promise<void> | undefined;
  const lease = withNativePlugin(async (fixture) => {
    const connected = await connectNativeSession(fixture);
    ready.resolve(
      AsyncLocalStorage.bind(() => {
        running = withParkedNativeTask(run, prompt, session, finish, { ...fixture, ...connected });
        return running;
      }),
    );
    await release.promise;
  });
  void lease.catch(ready.reject);
  const start = await ready.promise;
  return {
    start,
    async close() {
      // A timed-out assertion still joins its callback before the next test restores globals.
      finish();
      try {
        await running?.catch(() => {});
      } finally {
        release.resolve();
        await lease;
      }
    },
  };
}
