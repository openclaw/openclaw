import { normalizeDatabasePath } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSet } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-github-names.js";

type SecretStoreChange = { databasePath: string; githubOAuth: boolean };
const listeners = resolveGlobalSet<(change: SecretStoreChange) => void>(
  Symbol.for("openclaw.secretStoreChanges"),
  "close-and-restart",
);

export function subscribeSecretStoreChanges(listener: (change: SecretStoreChange) => void) {
  return registerListener(listeners, listener);
}

export function publishSecretStoreChange(databasePath: string, names?: readonly string[]): void {
  notifyListeners(listeners, {
    databasePath: normalizeDatabasePath(databasePath),
    githubOAuth:
      names === undefined ||
      names.some((name) => {
        const kind = classifyHiddenGitHubStoreName(name);
        return kind === "device" || kind === "oauth";
      }),
  });
}

/** Unknown outcomes also invalidate maintenance facts; they never authorize credential use. */
export function observeSecretStoreMutation<T>(
  operation: Promise<T>,
  databasePath: string,
  names?: readonly string[],
): Promise<T> {
  return operation.finally(() => publishSecretStoreChange(databasePath, names));
}
