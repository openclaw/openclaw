import path from "node:path";

export type QaProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

export function parseQaArtifactBase(argv: readonly string[]): string {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

export function parseQaProducerOptions(argv: readonly string[]): QaProducerOptions {
  const artifactBase = parseQaArtifactBase(argv);
  const index = argv.indexOf("--repo-root");
  const repoRoot = index >= 0 ? argv[index + 1] : undefined;
  return {
    artifactBase,
    repoRoot: path.resolve(repoRoot ?? process.cwd()),
  };
}
