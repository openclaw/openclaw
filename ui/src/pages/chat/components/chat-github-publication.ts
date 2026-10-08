import { createGitHubPublicationRenderer } from "@openclaw/github/control-ui-api.js";
import "../../../components/tooltip.ts";
import { githubPresentationHost } from "./github-presentation-host.ts";

export const { renderGitHubPublicationAction } =
  createGitHubPublicationRenderer(githubPresentationHost);
