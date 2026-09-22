import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enGitHubPreview = {
  githubPreview: {
    cached: "Cached details",
    coAuthors: "Co-authored by {logins}",
    loading: "Loading GitHub details…",
    unavailable: "GitHub preview unavailable",
    states: {
      merged: "Merged",
      draft: "Draft",
      open: "Open",
      closed: "Closed",
      notPlanned: "Not planned",
    },
    file: "{count} file",
    files: "{count} files",
    comment: "{count} comment",
    comments: "{count} comments",
    pullRequest: "pull request",
    issue: "issue",
    ariaLabel: "{state} {kind} {repo} #{number}: {title}, by {author}",
    ariaLabelWithoutAuthor: "{state} {kind} {repo} #{number}: {title}",
  },
} satisfies TranslationMap;

export const registerGitHubPreviewEnglish = Object.assign(
  () => {
    en.githubPreview = enGitHubPreview.githubPreview;
  },
  { catalog: enGitHubPreview },
);
