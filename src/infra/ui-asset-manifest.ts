import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const UI_ASSET_MANIFEST_FILE = "asset-manifest.json";

export type UiAssetManifest = {
  schema_version: 1;
  generated_by: "openclaw";
  root: "dist/control-ui";
  files: Record<string, string>;
};

export type UiAssetVerificationResult =
  | {
      ok: true;
      manifestSha: string;
      fileCount: number;
      errors: [];
    }
  | {
      ok: false;
      manifestSha: string | null;
      fileCount: number;
      errors: string[];
    };

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isFileIncluded(relPath: string): boolean {
  if (!relPath || relPath === UI_ASSET_MANIFEST_FILE) {
    return false;
  }
  if (relPath === "index.html") {
    return true;
  }
  return relPath.startsWith("assets/");
}

function walkFiles(root: string, dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, absPath, acc);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relPath = path.relative(root, absPath).replaceAll(path.sep, "/");
    if (isFileIncluded(relPath)) {
      acc.push(relPath);
    }
  }
}

export function buildUiAssetManifest(controlUiRoot: string): UiAssetManifest {
  const root = path.resolve(controlUiRoot);
  const relFiles: string[] = [];
  walkFiles(root, root, relFiles);
  relFiles.sort((a, b) => a.localeCompare(b));

  const files: Record<string, string> = {};
  for (const relPath of relFiles) {
    const absPath = path.join(root, relPath);
    files[relPath] = sha256Hex(fs.readFileSync(absPath));
  }

  return {
    schema_version: 1,
    generated_by: "openclaw",
    root: "dist/control-ui",
    files,
  };
}

export function canonicalManifestJson(manifest: UiAssetManifest): string {
  const sortedFiles = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(
    {
      schema_version: manifest.schema_version,
      generated_by: manifest.generated_by,
      root: manifest.root,
      files: sortedFiles,
    },
    null,
    2,
  );
}

export function computeUiManifestSha(manifest: UiAssetManifest): string {
  return sha256Hex(canonicalManifestJson(manifest));
}

export function writeUiAssetManifest(controlUiRoot: string): {
  manifest: UiAssetManifest;
  manifestSha: string;
  outputPath: string;
} {
  const manifest = buildUiAssetManifest(controlUiRoot);
  const manifestSha = computeUiManifestSha(manifest);
  const outputPath = path.join(path.resolve(controlUiRoot), UI_ASSET_MANIFEST_FILE);
  fs.writeFileSync(outputPath, `${canonicalManifestJson(manifest)}\n`, "utf8");
  return { manifest, manifestSha, outputPath };
}

export function verifyUiAssetManifest(controlUiRoot: string): UiAssetVerificationResult {
  const root = path.resolve(controlUiRoot);
  const manifestPath = path.join(root, UI_ASSET_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      manifestSha: null,
      fileCount: 0,
      errors: [`missing ${UI_ASSET_MANIFEST_FILE}`],
    };
  }

  let parsed: UiAssetManifest;
  let manifestSha: string | null = null;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    parsed = JSON.parse(raw) as UiAssetManifest;
    manifestSha = computeUiManifestSha(parsed);
  } catch (err) {
    return {
      ok: false,
      manifestSha: null,
      fileCount: 0,
      errors: [`invalid ${UI_ASSET_MANIFEST_FILE}: ${String(err)}`],
    };
  }

  if (parsed.schema_version !== 1 || parsed.generated_by !== "openclaw") {
    return {
      ok: false,
      manifestSha,
      fileCount: 0,
      errors: ["manifest schema mismatch"],
    };
  }

  const entries = Object.entries(parsed.files ?? {});
  if (entries.length === 0) {
    return {
      ok: false,
      manifestSha,
      fileCount: 0,
      errors: ["manifest files list is empty"],
    };
  }

  const errors: string[] = [];
  for (const [relPath, expectedSha] of entries) {
    if (!isFileIncluded(relPath)) {
      errors.push(`unexpected file entry: ${relPath}`);
      continue;
    }
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`missing file: ${relPath}`);
      continue;
    }
    const actualSha = sha256Hex(fs.readFileSync(absPath));
    if (actualSha !== expectedSha) {
      errors.push(`hash mismatch for ${relPath}: expected ${expectedSha} got ${actualSha}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifestSha, fileCount: entries.length, errors };
  }
  return { ok: true, manifestSha, fileCount: entries.length, errors: [] };
}
