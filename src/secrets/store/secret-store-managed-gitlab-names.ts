import { SecretStoreValidationError } from "./secret-store-validation-error.js";

export type HiddenGitLabStorePrefix = "gitlab-setup" | "gitlab-oauth";
export const GITLAB_SETUP_STORE_MAX_AGE_MS = 10 * 60_000;
const NAME = /^gitlab-(setup|oauth)-[a-f0-9]{32}$/u;

export function classifyHiddenGitLabStoreName(name: string): "setup" | "oauth" | undefined {
  const kind = NAME.exec(name)?.[1];
  return kind === "setup" || kind === "oauth" ? kind : undefined;
}

export function assertHiddenGitLabSecretRecordName(name: string): "setup" | "oauth" {
  const kind = classifyHiddenGitLabStoreName(name);
  if (!kind) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      "Hidden GitLab record name must match gitlab-setup-<32 hex> or gitlab-oauth-<32 hex>.",
    );
  }
  return kind;
}

export function hiddenGitLabStoreKindFromPrefix(prefix: HiddenGitLabStorePrefix) {
  if (prefix === "gitlab-setup") {
    return "setup" as const;
  }
  if (prefix === "gitlab-oauth") {
    return "oauth" as const;
  }
  throw new SecretStoreValidationError(
    "SECRET_STORE_INVALID_NAME",
    "Invalid GitLab record prefix.",
  );
}
