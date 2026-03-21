import { inspectSlackAccount as inspectSlackAccountImpl } from "openclaw/plugin-sdk/slack";

export type { InspectedSlackAccount } from "openclaw/plugin-sdk/slack";

type InspectSlackAccount = typeof import("openclaw/plugin-sdk/slack").inspectSlackAccount;

export function inspectSlackAccount(
  ...args: Parameters<InspectSlackAccount>
): ReturnType<InspectSlackAccount> {
  return inspectSlackAccountImpl(...args);
}
