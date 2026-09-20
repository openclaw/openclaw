/** Runtime facade for config-driven reply resolution. */
import { prewarmReplyRunRuntimes } from "./get-reply-run-helpers.js";
export { getReplyFromConfig } from "./get-reply.js";

export async function prewarmConfigDrivenReplyRuntime(): Promise<void> {
  await prewarmReplyRunRuntimes();
}
