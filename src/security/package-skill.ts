import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { SkillSecurityPackageMetadata, SkillSecurityPublisherMetadata } from "./skill-security-types.js";

export const DETERMINISTIC_PACKAGE_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const IGNORED_FILENAMES = new Set([".DS_Store"]);

export type DeterministicSkillPackageParams = {
  skillDir: string;
  skillName: string;
  version: string;
  publisher: SkillSecurityPublisherMetadata;
  createdAt?: string;
  outputPath?: string;
};

export type DeterministicSkillPackageResult = {
  bundle: Buffer;
  bundlePath: string | null;
  metadata: SkillSecurityPackageMetadata;
};

function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}

async function walkSkillFiles(rootDir: string, currentDir: string, result: string[]): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (IGNORED_FILENAMES.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkSkillFiles(rootDir, absolutePath, result);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = toPosixPath(path.relative(rootDir, absolutePath));
    result.push(relativePath);
  }
}

export async function listSkillSourceFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkSkillFiles(skillDir, skillDir, files);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export function buildSkillPackageMetadata(params: {
  skillName: string;
  version: string;
  publisher: SkillSecurityPublisherMetadata;
  createdAt?: string;
  sourceFiles: string[];
}): SkillSecurityPackageMetadata {
  const createdAt = params.createdAt ?? DETERMINISTIC_PACKAGE_TIMESTAMP;
  return {
    formatVersion: 1,
    skillName: params.skillName,
    version: params.version,
    publisher: params.publisher,
    createdAt,
    sourceFiles: [...params.sourceFiles],
    packageHashSha256: null,
    packaging: {
      ordering: "lexical",
      compression: "STORE",
      timestamp: createdAt,
    },
  };
}

export async function createDeterministicSkillBundle(
  params: DeterministicSkillPackageParams,
): Promise<DeterministicSkillPackageResult> {
  const sourceFiles = await listSkillSourceFiles(params.skillDir);
  const metadata = buildSkillPackageMetadata({
    skillName: params.skillName,
    version: params.version,
    publisher: params.publisher,
    createdAt: params.createdAt,
    sourceFiles,
  });
  const zip = new JSZip();
  const stableDate = new Date(metadata.packaging.timestamp);

  for (const relativePath of sourceFiles) {
    const absolutePath = path.join(params.skillDir, relativePath);
    const content = await fs.readFile(absolutePath);
    zip.file(relativePath, content, {
      date: stableDate,
      compression: "STORE",
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }

  zip.file("_meta.json", `${JSON.stringify(metadata, null, 2)}\n`, {
    date: stableDate,
    compression: "STORE",
    unixPermissions: 0o100644,
    createFolders: false,
  });

  const bundle = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
    streamFiles: false,
  });

  if (!params.outputPath) {
    return { bundle, bundlePath: null, metadata };
  }

  await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fs.writeFile(params.outputPath, bundle);
  return { bundle, bundlePath: params.outputPath, metadata };
}

export function buildDefaultSkillBundlePath(params: { skillName: string; version: string }): string {
  const safeName = `${params.skillName}-${params.version}`.replace(/[^a-z0-9._-]+/gi, "-");
  return path.join(os.tmpdir(), "radar-claw-defender", `${safeName}.zip`);
}
