import type { AllowlistMatch } from "../../channels/allowlist-match.js";
import {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../shared/string-normalization.js";

export function normalizeSlackSlug(raw?: string) {
  return normalizeHyphenSlug(raw);
}

export function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeStringEntriesLower(list);
}

export type SlackAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug"
>;

export function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): SlackAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) {
    return { allowed: false };
  }
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const id = params.id?.toLowerCase();
  const name = params.name?.toLowerCase();
  const slug = normalizeSlackSlug(name);
  const candidates: Array<{ value?: string; source: SlackAllowListMatch["matchSource"] }> = [
    { value: id, source: "id" },
    { value: id ? `slack:${id}` : undefined, source: "prefixed-id" },
    { value: id ? `user:${id}` : undefined, source: "prefixed-user" },
    ...(params.allowNameMatching === true
      ? ([
          { value: name, source: "name" as const },
          { value: name ? `slack:${name}` : undefined, source: "prefixed-name" as const },
          { value: slug, source: "slug" as const },
        ] satisfies Array<{ value?: string; source: SlackAllowListMatch["matchSource"] }>)
      : []),
  ];
  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }
    if (allowList.includes(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}) {
  return resolveSlackAllowListMatch(params).allowed;
}

export function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
  userName?: string;
  allowNameMatching?: boolean;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) {
    return true;
  }
  return allowListMatches({
    allowList,
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  });
}
