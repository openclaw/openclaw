import type { ApplicationContext } from "./context.ts";

/**
 * Every agent's GitHub account, and the shared agent account, are changed in Profile.
 * The app shell loads this on demand: reconnect requests are rare, so the destination
 * stays out of the boot bundle.
 */
export function openGitHubAccounts(context: Pick<ApplicationContext, "navigate">) {
  context.navigate("profile", { hash: "#settings-profile-github-connections" });
}
