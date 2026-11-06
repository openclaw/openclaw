export type PackageActivationRuntime = {
  kind: "node" | "bun";
  path: string;
  identity: string;
  /** Preflight snapshot filtered by the daemon runtime probe owner. */
  env?: NodeJS.ProcessEnv;
};
