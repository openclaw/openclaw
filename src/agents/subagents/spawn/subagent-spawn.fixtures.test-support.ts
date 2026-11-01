import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import type { NativePluginSpawnTestOptions } from "./subagent-spawn.production-boundary.test-support.js";

export type BoundaryHarness = Pick<
  NativePluginSpawnTestOptions,
  "createBoundGateway" | "closeBoundGateway" | "throwBoundFailures" | "runEmbeddedAgent"
>;
export type WaitForEmbeddedRun = NativePluginSpawnTestOptions["waitForEmbeddedRun"];

export function sessionReader(storePath: string) {
  return (sessionKey: string) => loadSessionEntry({ storePath, sessionKey });
}

export function visibleResult(text: string): EmbeddedAgentRunResult {
  return {
    payloads: [{ text }],
    meta: { durationMs: 1, terminalReply: { disposition: "visible", text } },
  };
}

export async function collectFailure(failures: unknown[], cleanup: () => unknown) {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}
