export type VerifiedUpgradeRecipeRunnerBundle = {
  readonly root: string;
  readonly purpose: "production" | "release-qualification";
  readonly manifestDigest: string;
  readonly closureDigest: string;
  readonly runtimePath: string;
  readonly entrypointPath: string;
  readonly releaseQualificationEntrypointPath?: string;
  readonly runtimeArtifactId: string;
  readonly bootstrapArtifactId: string;
  readonly nativeDependencies: readonly string[];
};
