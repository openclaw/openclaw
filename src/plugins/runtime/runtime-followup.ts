import { DEFAULT_MODEL } from "../../agents/defaults.js";
import { logVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import type { PluginRuntimeCore } from "./types-core.js";

export function createRuntimeFollowup(): PluginRuntimeCore["followup"] {
  return {
    async enqueueFollowupTurn(params) {
      try {
        const { buildFollowupRunForSession } =
          await import("../../auto-reply/reply/queue/build-followup-run.js");
        const { enqueueFollowupRun } = await import("../../auto-reply/reply/queue/enqueue.js");
        const { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } =
          await import("../../auto-reply/reply/queue/drain.js");

        const { getExistingFollowupQueue } = await import("../../auto-reply/reply/queue/state.js");

        const followupRun = await buildFollowupRunForSession(params);
        if (!followupRun) {
          return false;
        }

        // Preserve an existing queue's mode instead of forcing "followup".
        const existingMode = getExistingFollowupQueue(params.sessionKey)?.mode;
        const enqueued = enqueueFollowupRun(
          params.sessionKey,
          followupRun,
          { mode: existingMode ?? "followup" },
          "none",
          undefined,
          false,
        );
        if (!enqueued) {
          return false;
        }

        const { createFollowupRunner } = await import("../../auto-reply/reply/followup-runner.js");
        const { createTypingController } = await import("../../auto-reply/reply/typing.js");

        const noopTyping = createTypingController({});
        const runner = createFollowupRunner({
          typing: noopTyping,
          typingMode: "never",
          defaultModel: followupRun.run.model ?? DEFAULT_MODEL,
        });

        // Fix 3: Try existing callback first (hot session) to avoid overwriting
        // a channel-aware runner that's already active.
        kickFollowupDrainIfIdle(params.sessionKey);

        // Check if drain started from existing callback.
        const queue = getExistingFollowupQueue(params.sessionKey);
        if (!queue?.draining) {
          // Cold session — no existing callback found. Register the fresh noop runner.
          rememberFollowupDrainCallback(params.sessionKey, runner);
          kickFollowupDrainIfIdle(params.sessionKey);
        }
        logVerbose(`[runtime.followup] enqueued followup turn for session "${params.sessionKey}"`);
        return true;
      } catch (err) {
        defaultRuntime.error?.(
          `[runtime.followup] enqueueFollowupTurn failed for session "${params.sessionKey}": ${String(err)}`,
        );
        return false;
      }
    },
  };
}
