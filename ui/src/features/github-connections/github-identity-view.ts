import { createGitHubIdentityRenderer } from "@openclaw/github/control-ui-identity-api.js";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { githubIdentityHost } from "./github-identity-host.ts";

registerGitHubEnglish();

export const { renderGitHubIdentity } = createGitHubIdentityRenderer(githubIdentityHost);
