import { link, lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import * as tar from "tar";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { digestTemplateBytes } from "./digest.js";
import {
  TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
  TemplateProjectError,
  validateTemplateProject,
} from "./project.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export const TEMPLATE_BUILD_RESULT_SCHEMA_VERSION = "openclaw.templateBuild.v1" as const;

// zlib's public numeric API defines Z_FILTERED as strategy 1.
const ZLIB_FILTERED_STRATEGY = 1;

async function readSelectedProjectFile(projectRoot: string, path: string): Promise<Buffer> {
  const sourceRoot = await fsSafeRoot(projectRoot);
  const read = await sourceRoot.read(path, {
    hardlinks: "reject",
    maxBytes: MAX_MANAGED_FILE_BYTES,
    symlinks: path === "CLAW.md" ? "follow-within-root" : "reject",
  });
  return read.buffer;
}

function assertValidatedBytes(
  path: string,
  bytes: Buffer,
  expected: { byteLength: number; digest: string },
): void {
  const digest = digestTemplateBytes(bytes);
  if (bytes.byteLength !== expected.byteLength || digest !== expected.digest) {
    throw new TemplateProjectError(
      "project_changed_during_build",
      `Template project input ${JSON.stringify(path)} changed after validation; retry the build from a stable snapshot.`,
    );
  }
}

export async function extractBuiltTemplateArtifact(
  artifact: string,
): Promise<AsyncDisposable & { packageRoot: string }> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-template-artifact-",
  });
  try {
    await tar.x({ cwd: workspace.dir, file: resolve(artifact), strict: true });
    const packageRoot = workspace.path("package");
    const packageStat = await lstat(packageRoot);
    if (!packageStat.isDirectory()) {
      throw new Error("artifact does not contain a package directory");
    }
    return { packageRoot, [Symbol.asyncDispose]: workspace[Symbol.asyncDispose] };
  } catch (error) {
    await workspace[Symbol.asyncDispose]();
    throw new TemplateProjectError(
      "artifact_verification_failed",
      `Could not extract built Template artifact: ${(error as Error).message}`,
    );
  }
}

export async function buildTemplateProject(projectPath: string, outputPath: string) {
  const project = await validateTemplateProject(projectPath);
  if (!project.ok) {
    throw new TemplateProjectError(
      "project_invalid",
      project.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
    );
  }

  const artifact = resolve(outputPath);
  if (!artifact.toLowerCase().endsWith(".tgz")) {
    throw new TemplateProjectError(
      "invalid_artifact_path",
      "Template build output must end in .tgz.",
    );
  }
  if (await lstat(artifact).catch(() => undefined)) {
    throw new TemplateProjectError(
      "artifact_exists",
      `Refusing to overwrite existing artifact ${JSON.stringify(artifact)}.`,
    );
  }
  const outputParent = await stat(dirname(artifact)).catch(() => undefined);
  if (!outputParent?.isDirectory()) {
    throw new TemplateProjectError(
      "artifact_parent_missing",
      `Artifact parent directory ${JSON.stringify(dirname(artifact))} does not exist.`,
    );
  }

  const temporaryDirectory = await mkdtemp(join(dirname(artifact), ".openclaw-template-build-"));
  const stagingRoot = join(temporaryDirectory, "staging");
  const temporaryArtifact = join(temporaryDirectory, "template.tgz");
  try {
    await mkdir(stagingRoot, { mode: 0o755 });
    const staging = await fsSafeRoot(stagingRoot, { mkdir: false, mode: 0o644, durable: false });
    const files = new Map<string, Buffer | string>();
    files.set("package.json", `${JSON.stringify(project.packageJson, null, 2)}\n`);
    const templateMarkdown = await readSelectedProjectFile(project.root, "CLAW.md");
    assertValidatedBytes("CLAW.md", templateMarkdown, project.template.snapshot.manifest);
    files.set("CLAW.md", templateMarkdown);
    if (project.license) {
      const license = await readSelectedProjectFile(project.root, "LICENSE");
      assertValidatedBytes("LICENSE", license, project.license);
      files.set("LICENSE", license);
    }
    if (project.template.packageBootstrap) {
      const bootstrap = await readSelectedProjectFile(project.root, "BOOTSTRAP.md");
      assertValidatedBytes("BOOTSTRAP.md", bootstrap, project.template.packageBootstrap);
      files.set("BOOTSTRAP.md", bootstrap);
    }
    if (project.template.openClawProfile) {
      const profileSnapshot = project.template.snapshot.openClawProfile;
      if (!profileSnapshot) {
        throw new TemplateProjectError(
          "project_invalid",
          "Validated OpenClaw profile is missing its source snapshot.",
        );
      }
      const profile = await readSelectedProjectFile(project.root, profileSnapshot.sourcePath);
      assertValidatedBytes(profileSnapshot.sourcePath, profile, profileSnapshot);
      files.set(profileSnapshot.sourcePath, profile);
    }
    for (const source of project.template.snapshot.workspaceSources) {
      const bytes = await readSelectedProjectFile(project.root, source.sourcePath);
      assertValidatedBytes(source.sourcePath, bytes, source);
      files.set(source.sourcePath, bytes);
    }

    const fileNames = [...files.keys()].toSorted((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const fileName of fileNames) {
      await mkdir(join(stagingRoot, dirname(fileName)), { recursive: true, mode: 0o755 });
      await staging.create(fileName, files.get(fileName) as Buffer | string);
    }
    const tarInputNames = fileNames.map((fileName) =>
      fileName.startsWith("@") ? `./${fileName}` : fileName,
    );

    await tar.c(
      {
        cwd: stagingRoot,
        file: temporaryArtifact,
        // Stabilize supported zlib output without disabling normal match compression.
        gzip: { level: 9, portable: true, strategy: ZLIB_FILTERED_STRATEGY },
        mtime: new Date(0),
        portable: true,
        prefix: "package",
      },
      tarInputNames,
    );

    const packed = await readFile(temporaryArtifact);
    const integrity = digestTemplateBytes(packed);

    try {
      await link(temporaryArtifact, artifact);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new TemplateProjectError(
          "artifact_exists",
          `Refusing to overwrite existing artifact ${JSON.stringify(artifact)}.`,
        );
      }
      throw new TemplateProjectError(
        "artifact_atomic_publish_failed",
        `Could not atomically publish artifact ${JSON.stringify(artifact)}: ${(error as Error).message}`,
      );
    }
    return {
      schemaVersion: TEMPLATE_BUILD_RESULT_SCHEMA_VERSION,
      projectSchemaVersion: TEMPLATE_PROJECT_RESULT_SCHEMA_VERSION,
      artifact,
      integrity,
      byteLength: packed.byteLength,
      files: fileNames,
      excludedPaths: project.excludedPaths,
      template: { name: project.packageJson.name, version: project.packageJson.version },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
