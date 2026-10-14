import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { normalizeCloudRepo } from "../config/cloud-worker-project-profiles.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";

/** Operator repository selection shared by the picker and prepared pool. */
export function configuredDefaultRepository(
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
) {
  const selected = config?.gateway?.projects?.defaultRepository;
  if (!selected) {
    return undefined;
  }
  const parsed = parseProjectGitUrl(selected.url, resolveConfiguredGitHubHost(config));
  if (!parsed) {
    return undefined;
  }
  const identity = new URL(parsed.url).pathname.slice(1, -4);
  const key = normalizeCloudRepo(parsed.url);
  const profileId = key ? config?.cloudWorkers?.projectProfiles?.[key] : undefined;
  return {
    identity,
    url: parsed.url,
    ...(selected.ref ? { ref: selected.ref } : {}),
    ...(profileId ? { profileId } : {}),
  };
}
