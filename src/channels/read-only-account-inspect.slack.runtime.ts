import { inspectSlackAccount as inspectSlackAccountImpl } from "../../extensions/slack/api.js";

export type { InspectedSlackAccount } from "../../extensions/slack/api.js";

type InspectSlackAccount = typeof import("../../extensions/slack/api.js").inspectSlackAccount;

export function inspectSlackAccount(
  ...args: Parameters<InspectSlackAccount>
): ReturnType<InspectSlackAccount> {
  return inspectSlackAccountImpl(...args);
}
