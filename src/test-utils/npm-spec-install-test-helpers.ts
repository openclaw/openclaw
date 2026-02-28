import { expect } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import { expectSingleNpmInstallIgnoreScriptsCall } from "./exec-assertions.js";

export type InstallResultLike = {
  ok: boolean;
  error?: string;
};

export type NpmPackMetadata = {
  id: string;
  name: string;
  version: string;
  filename: string;
  integrity: string;
  shasum: string;
};

export function createSuccessfulSpawnResult(stdout = ""): SpawnResult {
  return {
    code: 0,
    stdout,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  };
}

export async function expectUnsupportedNpmSpec(
  install: (spec: string) => Promise<InstallResultLike>,
  spec = "github:evil/evil",
) {
  const result = await install(spec);
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toContain("unsupported npm spec");
}

export function mockNpmPackMetadataResult(
  run: { mockResolvedValue: (value: SpawnResult) => unknown },
  metadata: NpmPackMetadata,
) {
  run.mockResolvedValue(createSuccessfulSpawnResult(JSON.stringify([metadata])));
}

export function expectIntegrityDriftRejected(params: {
  onIntegrityDrift: (...args: unknown[]) => unknown;
  result: InstallResultLike;
  expectedIntegrity: string;
  actualIntegrity: string;
}) {
  expect(params.onIntegrityDrift).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIntegrity: params.expectedIntegrity,
      actualIntegrity: params.actualIntegrity,
    }),
  );
  expect(params.result.ok).toBe(false);
  if (params.result.ok) {
    return;
  }
  expect(params.result.error).toContain("integrity drift");
}

export async function expectInstallUsesIgnoreScripts(params: {
  run: {
    mockResolvedValue: (value: SpawnResult) => unknown;
    mock: { calls: unknown[][] };
  };
  install: () => Promise<
    | {
        ok: true;
        targetDir: string;
      }
    | {
        ok: false;
        error?: string;
      }
  >;
}) {
  params.run.mockResolvedValue(createSuccessfulSpawnResult());
  const result = await params.install();
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expectSingleNpmInstallIgnoreScriptsCall({
    calls: params.run.mock.calls as Array<[unknown, { cwd?: string } | undefined]>,
    expectedCwd: result.targetDir,
  });
}
