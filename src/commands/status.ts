import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatMessageLine } from "../twilio/messages.js";

export async function statusCommand(
  opts: { limit: string; lookback: string; json?: boolean },
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const limit = Number.parseInt(opts.limit, 10);
  const lookbackMinutes = Number.parseInt(opts.lookback, 10);
  if (Number.isNaN(limit) || limit <= 0 || limit > 200) {
    throw new Error("limit must be between 1 and 200");
  }
  if (Number.isNaN(lookbackMinutes) || lookbackMinutes <= 0) {
    throw new Error("lookback must be > 0 minutes");
  }

  const messages = await deps.listRecentMessages(lookbackMinutes, limit);
  if (opts.json) {
    runtime.log(JSON.stringify(messages, null, 2));
    return;
  }
  if (messages.length === 0) {
    runtime.log("No messages found in the requested window.");
    return;
  }
  for (const m of messages) {
    runtime.log(formatMessageLine(m));
  }
}
