import type { ApplicationContext } from "../../app/context.ts";

/** Every agent's GitHub account, and the shared agent account, are changed in Profile. */
export function openGitHubAccounts(context: Pick<ApplicationContext, "navigate">) {
  context.navigate("profile", { hash: "#settings-profile-github-connections" });
}
