import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packNpmSpecToArchive } from "../infra/install-source-utils.js";
import { buildClawProject, extractBuiltClawArtifact } from "./project-build.js";

export async function stageOfficialExportArtifact(params: {
  projectRoot: string;
  stateDir: string;
  artifactDir: string;
  legacyBuilder?: boolean;
}): Promise<{ packageRoot: string; integrity: string; byteLength: number }> {
  let archivePath: string;
  if (params.legacyBuilder) {
    const built = await buildClawProject(
      params.projectRoot,
      join(params.artifactDir, "source.tgz"),
    );
    archivePath = built.artifact;
  } else {
    const packed = await packNpmSpecToArchive({
      spec: params.projectRoot,
      cwd: params.artifactDir,
      timeoutMs: 30_000,
    });
    if (!packed.ok) {
      throw new Error(packed.error);
    }
    archivePath = packed.archivePath;
  }
  const bytes = await readFile(archivePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const packageRoot = join(params.stateDir, "claws", "sources", digest);
  await mkdir(dirname(packageRoot), { recursive: true });
  await using extracted = await extractBuiltClawArtifact(archivePath);
  await cp(extracted.packageRoot, packageRoot, { recursive: true });
  if (!params.legacyBuilder) {
    await copyFile(archivePath, `${packageRoot}.tgz`);
  }
  return { packageRoot, integrity: `sha256:${digest}`, byteLength: bytes.byteLength };
}
