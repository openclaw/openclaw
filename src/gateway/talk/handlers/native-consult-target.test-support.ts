import { onTestFinished, vi } from "vitest";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { registerChatAbortController } from "../../chat-abort.js";
import { claimRpcSourceForTest } from "../../test-helpers.rpc-source.js";
import { prepareTalkSessionTarget } from "../session-target.js";

/** Retains admitted source custody for exact late-control and adoption race fixtures. */
export async function registerOwnedNativeConsultRun(
  config: OpenClawConfig,
  ownerConnId: string,
  runId: string,
  sessionId: string,
  options: { executionStarted?: boolean } = {},
) {
  const target = await prepareTalkSessionTarget(config, "main");
  const registration = registerChatAbortController({
    runId,
    sessionId,
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: "global",
      agentId: "voice",
      incarnation: sessionId,
    }),
    sessionKey: "global",
    agentId: "voice",
    ownerConnId,
    timeoutMs: 60_000,
    kind: "chat-send",
  });
  if (!registration.registered) {
    throw new Error("Missing owned Talk source");
  }
  const releaseClaim = await claimRpcSourceForTest(registration.entry, options);
  onTestFinished(() => {
    releaseClaim();
    registration.cleanup();
  });
  const abort = vi.fn();
  if (options.executionStarted !== false) {
    setActiveEmbeddedRun(
      sessionId,
      createEmbeddedRunHandle({ runId, abort }),
      "global",
      undefined,
      "voice",
      registration.entry.input.claim!.operation!,
    );
  }
  return { registration, abort };
}
