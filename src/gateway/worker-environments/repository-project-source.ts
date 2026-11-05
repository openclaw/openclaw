import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  RepositoryWorkerProjectSchema,
  type RepositoryWorkerProjectSnapshot,
} from "./repository-project-source.schema.js";

/** Repository facts persist; current visibility and access remain admission checks. */
export function readRepositoryWorkerProjectSnapshot(
  value: unknown,
): RepositoryWorkerProjectSnapshot | undefined {
  if (!isRecord(value) || value.source === undefined) {
    return undefined;
  }
  const parsed = RepositoryWorkerProjectSchema.safeParse(value);
  const source = parsed.success ? parsed.data.source : undefined;
  const url = source && URL.canParse(source.url) ? new URL(source.url) : undefined;
  if (
    Object.keys(value).some(
      (key) => !["key", "baseCommit", "source", "preparation"].includes(key),
    ) ||
    !parsed.success ||
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== parsed.data.source.url
  ) {
    throw new Error("Worker environment has an invalid repository preparation snapshot");
  }
  repositoryWorkerSourceBinding(parsed.data.source);
  return parsed.data;
}

/** Project saved source authority without changing its accepted content/cache identity. */
export function repositoryWorkerSourceBinding(source: RepositoryWorkerProjectSnapshot["source"]) {
  const identity = source.owner.identity;
  if (identity.source !== "plugin") {
    if (source.repositorySourceId !== undefined) {
      throw new Error("Worker environment has an invalid repository preparation snapshot");
    }
    return {
      sourceId: "github-repositories/repositories",
      // The saved native format predates opaque plugin keys. Preserve the
      // source worker's original field order without loading plugin code.
      identityKey: JSON.stringify(
        identity.source === "anonymous"
          ? { source: identity.source }
          : identity.source === "system-detected"
            ? { source: identity.source, accountId: identity.accountId }
            : {
                source: identity.source,
                accountId: identity.accountId,
                profileId: identity.profileId,
              },
      ),
    };
  }
  if (!source.repositorySourceId) {
    throw new Error("Worker environment has an invalid repository preparation snapshot");
  }
  return { sourceId: source.repositorySourceId, identityKey: identity.key };
}
