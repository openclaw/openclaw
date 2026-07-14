/**
 * Sleep/wait built-in tool.
 *
 * Suspends the current turn for N seconds by yielding and scheduling a
 * one-shot wake event.  This allows the agent to pause without burning tokens
 * or spamming poll loops.
 *
 * Behavior:
 *   1. Schedule a process-local wake event after `seconds` targeting the
 *      current session
 *   2. Invoke the `onYield` callback — the agent loop maps this to
 *      stopReason: "end_turn" and ends the current turn
 *   3. The gateway resumes the session when the wake fires
 *
 * Linked issue: openclaw/openclaw#101190
 */

import { Type } from "typebox";
import { SLEEP_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import type { CronCreatorToolAllowlistEntry } from "./cron-tool.js";
import type { GatewayCallOptions } from "./gateway.js";

const SleepToolSchema = Type.Object({
  seconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 600,
      default: 60,
      description:
        "Seconds to sleep before resuming (1–600; defaults to 60). Use instead of polling loops for long-running external processes.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Message injected when waking (reminder context so the agent can resume).",
    }),
  ),
});

type SleepGatewayCaller = (
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { requireAgentRuntimeIdentity?: boolean },
) => Promise<unknown>;

function resolveCreatorToolNames(entries: readonly CronCreatorToolAllowlistEntry[] | undefined) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    const name = (typeof entry === "string" ? entry : entry.name).trim().toLowerCase();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Schedule the one-shot wake through the scoped transient-sleep RPC. */
export async function scheduleSleepWake(params: {
  seconds: number;
  message: string;
  sessionKey?: string;
  creatorToolAllowlist?: readonly CronCreatorToolAllowlistEntry[];
  callGateway: SleepGatewayCaller;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("No session context");
  }
  const toolsAllow = params.creatorToolAllowlist
    ? { toolsAllow: resolveCreatorToolNames(params.creatorToolAllowlist) }
    : {};
  await params.callGateway(
    "sleep.schedule",
    {},
    {
      seconds: params.seconds,
      message: params.message,
      ...toolsAllow,
      sessionKey,
    },
    { requireAgentRuntimeIdentity: true },
  );
}

/** Creates the sleep tool for runtimes that support yield callbacks. */
export function createSleepTool(opts?: {
  sessionKey?: string;
  /** End the current turn (same callback as sessions_yield). */
  onYield?: (message: string) => Promise<void> | void;
  /**
   * Schedule a transient one-shot wake that runs an agent turn targeted at the
   * current session after `seconds` has elapsed.
   *
   * Scheduling must succeed before the current turn yields.
   */
  scheduleWake?: (seconds: number, message: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Sleep",
    name: "sleep",
    displaySummary: SLEEP_TOOL_DISPLAY_SUMMARY,
    description: `${SLEEP_TOOL_DISPLAY_SUMMARY} The turn ends immediately and resumes when the timer fires (max 600 s). Use instead of polling loops for long-running external processes.`,
    parameters: SleepToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const seconds = readNumberParam(params, "seconds") ?? 60;
      const message =
        readStringParam(params, "message") ?? "Sleep timer fired. Resume pending work.";

      if (!opts?.sessionKey?.trim()) {
        return jsonResult({ status: "error", error: "No session context" });
      }

      if (!opts?.onYield) {
        return jsonResult({
          status: "error",
          error: "Yield not supported in this context",
        });
      }

      if (!opts.scheduleWake) {
        return jsonResult({
          status: "error",
          error: "Wake scheduling not supported in this context",
        });
      }

      if (seconds > 600) {
        return jsonResult({
          status: "error",
          error: "Max sleep duration is 600 seconds. Use cron for longer waits.",
        });
      }

      if (seconds < 1) {
        return jsonResult({
          status: "error",
          error: "Sleep duration must be at least 1 second.",
        });
      }

      // Schedule wake event before yielding the turn.
      await opts.scheduleWake(seconds, message);

      // Yield — onYield is wired to the agent loop's yield mechanism which maps
      // to stopReason: "end_turn", ending the current turn. The scheduled wake
      // event resumes the session when the timer fires.
      await opts.onYield(`Sleeping for ${seconds}s: ${message}`);

      return jsonResult({
        status: "yielded",
        message: `Sleeping for ${seconds}s. Will resume with: ${message}`,
        seconds,
      });
    },
  };
}
