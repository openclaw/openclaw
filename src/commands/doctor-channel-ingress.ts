import { note } from "../../packages/terminal-core/src/note.js";
import { countFailedChannelIngressQueueEntries } from "../channels/message/ingress-queue-health.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";

export async function noteChannelIngressDeadLetters(
  options: { stateDir?: string; noteFn?: typeof note } = {},
): Promise<void> {
  const failed = await countFailedChannelIngressQueueEntries(options.stateDir);
  const first = failed[0];
  if (!first) {
    return;
  }
  const lines = failed.map(
    (entry) =>
      `- ${entry.channelId}/${entry.accountId}: ${entry.count} dead-lettered ingress event${entry.count === 1 ? "" : "s"}.`,
  );
  lines.push(
    `- Inspect with ${formatCliCommand(
      `openclaw channels dead-letters list --channel ${quoteCliArg(first.channelId)} --account ${quoteCliArg(first.accountId)}`,
    )}.`,
  );
  (options.noteFn ?? note)(lines.join("\n"), "Channel ingress");
}
