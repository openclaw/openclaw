import fs from "node:fs";
import path from "node:path";
import { resolveCommitHash } from "../../infra/git-commit.js";
import { verifyUiAssetManifest } from "../../infra/ui-asset-manifest.js";

export type UiAssetRuntimeStatus = {
  verified: boolean;
  ok: boolean;
  manifestSha: string | null;
  fileCount: number;
  errors: string[];
};

export type BuildProvenance = {
  git_sha: string | null;
  build_id: string | null;
  ui_manifest_sha: string | null;
};

export function readBuildProvenance(cwd = process.cwd()): BuildProvenance {
  const candidates = [
    path.resolve(cwd, "dist", "build-info.json"),
    path.resolve(cwd, "build-info.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as {
        git_sha?: string | null;
        build_id?: string | null;
        ui_manifest_sha?: string | null;
      };
      return {
        git_sha: parsed.git_sha ?? resolveCommitHash({ cwd }),
        build_id: parsed.build_id ?? null,
        ui_manifest_sha: parsed.ui_manifest_sha ?? null,
      };
    } catch {
      // ignore
    }
  }

  return {
    git_sha: resolveCommitHash({ cwd }),
    build_id: null,
    ui_manifest_sha: null,
  };
}

export function verifyControlUiAssets(controlUiRoot: string): UiAssetRuntimeStatus {
  const result = verifyUiAssetManifest(controlUiRoot);
  if (result.ok) {
    return {
      verified: true,
      ok: true,
      manifestSha: result.manifestSha,
      fileCount: result.fileCount,
      errors: [],
    };
  }
  return {
    verified: true,
    ok: false,
    manifestSha: result.manifestSha,
    fileCount: result.fileCount,
    errors: result.errors,
  };
}
