import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ManagedProjectSourceV1 } from "openclaw/plugin-sdk/repository-sources";
import { resolveConfiguredGitHubHost } from "../../extensions/github-repositories/host-api.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  refreshProjectCheckout,
} from "../../extensions/github-repositories/project-clone-runtime-api.js";
import { parseProjectGitUrl } from "../../extensions/github-repositories/project-url-api.js";
import {
  materializeProjectClone as materialize,
  refreshProjectClone as refresh,
} from "./project-clone.js";
type Options = Parameters<typeof cloneProjectCheckout>[1] & { path?: string };
function source(config: OpenClawConfig, options: Options): ManagedProjectSourceV1 {
  return {
    resolveUrl: (url) => parseProjectGitUrl(url, resolveConfiguredGitHubHost(config)),
    invalidUrlMessage:
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    clone: (input, supplied) => cloneProjectCheckout(input, { ...options, ...supplied }),
    ensureCommit: (input, supplied) =>
      ensureProjectCheckoutCommit(input, { ...options, ...supplied }),
    refresh: (input, supplied) => refreshProjectCheckout(input, { ...options, ...supplied }),
  };
}
// Fixture construction keeps database/environment selection direct while exercising the real host custodian.
export function materializeProjectClone(
  input: Parameters<typeof materialize>[0],
  options: Options = {},
  transport?: ManagedProjectSourceV1,
) {
  return materialize(input, options, transport ?? source(input.cfg, options));
}
export function refreshProjectClone(project: Parameters<typeof refresh>[0], options: Options = {}) {
  return refresh(project, options, source({}, options));
}
