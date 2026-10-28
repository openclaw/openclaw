import { prepareCronJobNameResolver } from "../cron/store/job-name.js";
import { readForwardedCronJobIds } from "./chat-display-projection.history.js";

export async function prepareForwardedMessageCronJobNameResolver(
  messages: readonly unknown[],
  storePath?: string,
) {
  return await prepareCronJobNameResolver(readForwardedCronJobIds(messages), storePath);
}
