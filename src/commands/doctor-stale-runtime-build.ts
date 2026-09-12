import type { HealthFinding } from "../flows/health-checks.js";
// Reports a checkout whose dist was built from a different commit than HEAD.
import { isTruthyEnvValue } from "../infra/env.js";
import { gitCommitPrefixesMatch, resolveCommitHash } from "../infra/git-commit.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { readBuiltRuntimeCommit } from "../infra/update-git-runtime.js";

const STALE_RUNTIME_BUILD_CHECK_ID = "core/doctor/stale-runtime-build";

export async function collectStaleRuntimeBuildFindings(
  params: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<readonly HealthFinding[]> {
  const env = params.env ?? process.env;
  // An update is stale by construction between pulling source and rebuilding
  // dist, so reporting there would flag the update against its own intermediate
  // state. Doctor runs inside update recovery; stay silent for that caller.
  if (isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS)) {
    return [];
  }
  const root = params.root ?? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!root) {
    return [];
  }
  const builtCommit = await readBuiltRuntimeCommit(root);
  // Source runs carry no build provenance, so only a real build can be stale.
  // Packaged installs ship provenance whose commit the checkout read falls back
  // to, which keeps them matching instead of reporting a phantom drift.
  if (!builtCommit) {
    return [];
  }
  // resolveCommitHash prefers GIT_COMMIT/GIT_SHA, which declare the *built*
  // identity for packaged installs. Honouring them here would compare the build
  // against itself (hiding real drift) or against an unrelated commit (inventing
  // it), so the checkout identity must come from the checkout alone.
  const { GIT_COMMIT: _gitCommit, GIT_SHA: _gitSha, ...checkoutEnv } = env;
  const checkoutCommit = resolveCommitHash({ cwd: root, env: checkoutEnv });
  if (!checkoutCommit || gitCommitPrefixesMatch(builtCommit, checkoutCommit)) {
    return [];
  }
  return [
    {
      checkId: STALE_RUNTIME_BUILD_CHECK_ID,
      severity: "warning",
      message: `Running build came from commit ${builtCommit.slice(0, 7)}, but the checkout is at ${checkoutCommit.slice(0, 7)}; the loaded runtime is older than its source.`,
      path: root,
      fixHint:
        "Rebuild with `pnpm build` so the running runtime matches the checkout, then restart the Gateway.",
    },
  ];
}
