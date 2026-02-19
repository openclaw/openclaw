import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  packNpmSpecToArchive,
  withTempDir,
} from "./install-source-utils.js";
import {
  type NpmIntegrityDriftPayload,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";

export type NpmSpecArchiveInstallFlowResult<TResult extends { ok: boolean }> =
  | {
      ok: false;
      error: string;
    }
  | {
      ok: true;
      installResult: TResult;
      npmResolution: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    };

export async function installFromNpmSpecArchive<TResult extends { ok: boolean }>(params: {
  tempDirPrefix: string;
  spec: string;
  timeoutMs: number;
  expectedIntegrity?: string;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
  installFromArchive: (params: { archivePath: string }) => Promise<TResult>;
}): Promise<NpmSpecArchiveInstallFlowResult<TResult>> {
  return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
    const packedResult = await packNpmSpecToArchive({
      spec: params.spec,
      timeoutMs: params.timeoutMs,
      cwd: tmpDir,
    });
    if (!packedResult.ok) {
      return packedResult;
    }

    const npmResolution: NpmSpecResolution = {
      ...packedResult.metadata,
      resolvedAt: new Date().toISOString(),
    };

    const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: params.spec,
      expectedIntegrity: params.expectedIntegrity,
      resolution: npmResolution,
      onIntegrityDrift: params.onIntegrityDrift,
      warn: params.warn,
    });
    if (driftResult.error) {
      return {
        ok: false,
        error: driftResult.error,
      };
    }

    const installResult = await params.installFromArchive({
      archivePath: packedResult.archivePath,
    });

    return {
      ok: true,
      installResult,
      npmResolution,
      integrityDrift: driftResult.integrityDrift,
    };
  });
}
