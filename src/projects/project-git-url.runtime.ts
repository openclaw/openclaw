import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import { parseProjectGitUrl } from "./project-git-url.js";

/** Gateway admission binds repository URLs to the selected GitHub host. */
export function parseConfiguredProjectGitUrl(raw: string) {
  return parseProjectGitUrl(raw, resolveGitHubHost());
}
