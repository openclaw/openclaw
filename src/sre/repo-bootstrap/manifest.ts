import path from "node:path";

export const REPO_CLONE_STRATEGY_VALUES = ["git_clone", "image_baked"] as const;
export const REPO_REFRESH_POLICY_VALUES = ["git_pull", "immutable"] as const;

export type RepoCloneStrategy = (typeof REPO_CLONE_STRATEGY_VALUES)[number];
export type RepoRefreshPolicy = (typeof REPO_REFRESH_POLICY_VALUES)[number];

export type RepoBootstrapEntry = {
  repoId: string;
  localPath: string;
  cloneStrategy: RepoCloneStrategy;
  refreshPolicy: RepoRefreshPolicy;
  sourceOfTruthDomains: string[];
};

export type RepoBootstrapManifest = {
  version: "sre.repo-bootstrap-manifest.v1";
  repos: RepoBootstrapEntry[];
};

export const DEFAULT_SRE_REPO_CHECKOUT_ROOT = "/Users/florian/morpho";

export function resolveSreRepoCheckoutRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_SRE_REPO_CHECKOUT_ROOT?.trim();
  return override ? path.resolve(override) : DEFAULT_SRE_REPO_CHECKOUT_ROOT;
}

export function createDefaultRepoBootstrapManifest(
  env: NodeJS.ProcessEnv = process.env,
): RepoBootstrapManifest {
  const root = resolveSreRepoCheckoutRoot(env);

  return {
    version: "sre.repo-bootstrap-manifest.v1",
    repos: [
      {
        repoId: "openclaw-sre",
        localPath: path.join(root, "openclaw-sre"),
        cloneStrategy: "image_baked",
        refreshPolicy: "immutable",
        sourceOfTruthDomains: ["runtime", "session", "sre-substrate"],
      },
      {
        repoId: "morpho-infra",
        localPath: path.join(root, "morpho-infra"),
        cloneStrategy: "image_baked",
        refreshPolicy: "immutable",
        sourceOfTruthDomains: ["infra", "terraform", "shared-ops"],
      },
      {
        repoId: "morpho-infra-helm",
        localPath: path.join(root, "morpho-infra-helm"),
        cloneStrategy: "image_baked",
        refreshPolicy: "immutable",
        sourceOfTruthDomains: ["chart", "environment-values", "seed-runtime"],
      },
    ],
  };
}

export function getRepoBootstrapEntry(
  manifest: RepoBootstrapManifest,
  repoId: string,
): RepoBootstrapEntry | undefined {
  return manifest.repos.find((repo) => repo.repoId === repoId);
}
