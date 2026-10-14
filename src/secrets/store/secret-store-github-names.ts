import { SecretStoreValidationError } from "./secret-store-validation-error.js";

type HiddenGitHubStoreKind = "device" | "oauth";
type HiddenGitHubStoreNameKind = "setup" | HiddenGitHubStoreKind;
export type HiddenGitHubStorePrefix = "github-device" | "github-oauth";

export const GITHUB_SETUP_HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const GITHUB_DEVICE_STORE_MAX_AGE_MS = 15 * 60_000;
const HIDDEN_GITHUB_STORE_NAME_PATTERN = /^github-(setup|device|oauth)-[a-f0-9]{32}$/u;

export function classifyHiddenGitHubStoreName(name: string): HiddenGitHubStoreNameKind | undefined {
  const kind = HIDDEN_GITHUB_STORE_NAME_PATTERN.exec(name)?.[1];
  return kind === "setup" || kind === "device" || kind === "oauth" ? kind : undefined;
}

export function assertHiddenGitHubSecretRecordName(name: string): HiddenGitHubStoreKind {
  const kind = classifyHiddenGitHubStoreName(name);
  if (kind !== "device" && kind !== "oauth") {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      "Hidden GitHub secret record name must match github-device-<32 lowercase hex characters> or github-oauth-<32 lowercase hex characters>.",
    );
  }
  return kind;
}

export function hiddenGitHubStoreKindFromPrefix(
  prefix: HiddenGitHubStorePrefix,
): HiddenGitHubStoreKind {
  if (prefix === "github-device") {
    return "device";
  }
  if (prefix === "github-oauth") {
    return "oauth";
  }
  throw new SecretStoreValidationError(
    "SECRET_STORE_INVALID_NAME",
    'Hidden GitHub secret record prefix must be "github-device" or "github-oauth".',
  );
}
