import { t } from "../../../lib/reactive/i18n.ts";
import {
  personalGitHubPublicationSelection,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-owner.ts";

export function sourceLabel(source: string, provider: GitHubPublicationView["provider"]): string {
  return t(
    source === "personal"
      ? provider === "gitlab"
        ? "githubPublication.gitlabPersonal"
        : "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : provider === "gitlab"
          ? "githubPublication.gitlabSystem"
          : "githubPublication.system",
  );
}

export function publicationButtonSelection(publication: GitHubPublicationView) {
  return (
    publication.selection ??
    (!publication.options?.shared ? personalGitHubPublicationSelection(publication.options) : null)
  );
}
