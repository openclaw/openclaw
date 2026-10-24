import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export function isProfileDisplayRow(value: unknown): value is ProfileDisplayRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.created_at === "number" &&
    typeof value.updated_at === "number" &&
    (value.has_avatar === 0 || value.has_avatar === 1) &&
    ["display_name", "avatar_mime", "avatar_sha256", "merged_into"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    (value.role === undefined || value.role === null || typeof value.role === "string") &&
    (value.githubAccountIds === undefined ||
      (Array.isArray(value.githubAccountIds) &&
        value.githubAccountIds.every((id) => Number.isSafeInteger(id) && id > 0))) &&
    (value.enterpriseGitHubAccounts === undefined ||
      (Array.isArray(value.enterpriseGitHubAccounts) &&
        value.enterpriseGitHubAccounts.every(
          (account) =>
            isRecord(account) &&
            typeof account.host === "string" &&
            typeof account.accountId === "number" &&
            Number.isSafeInteger(account.accountId) &&
            account.accountId > 0,
        )))
  );
}
