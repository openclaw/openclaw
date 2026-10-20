import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertNoUnmigratedWorkspaceState,
  assertWorkspaceStateMigrationReady,
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  resolveLegacyWorkspaceSourcePaths,
} from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";

const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-07-15T11:00:00.000Z\n`;

async function writeCandidates(candidates: string[], content?: string) {
  for (const candidate of candidates) {
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    const data = content ?? (candidate.includes("workspace-state") ? '{"version":1}\n' : marker);
    await fs.writeFile(candidate, data, "utf8");
  }
}

async function expectMissing(candidates: string[]) {
  for (const candidate of candidates) {
    await expect(fs.lstat(candidate)).rejects.toHaveProperty("code", "ENOENT");
  }
}

describe("legacy workspace reset cleanup", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
  afterEach(() => resetLegacyWorkspaceStateCheckForTest());

  let homeDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let options: { env: NodeJS.ProcessEnv; homedir: () => string };
  let paths: ReturnType<typeof resolveLegacyWorkspaceSourcePaths>;
  beforeEach(() => {
    homeDir = tempDirs.make("openclaw-workspace-legacy-cleanup-");
    stateDir = path.join(homeDir, "state");
    workspaceDir = path.join(homeDir, "workspace");
    options = {
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      homedir: () => homeDir,
    };
    paths = resolveLegacyWorkspaceSourcePaths(workspaceDir, options);
  });
  const prepare = () => prepareLegacyWorkspaceStateReset(workspaceDir, options);

  async function createAlias() {
    const targetDir = path.join(homeDir, "workspace-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, workspaceDir, process.platform === "win32" ? "junction" : "dir");
    return targetDir;
  }

  it("retains retired state when ownership expires during asynchronous validation", async () => {
    await fs.mkdir(workspaceDir, { recursive: true });
    const shortMarker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`;
    const siblingPath = `${workspaceDir}.attested`;
    await fs.writeFile(siblingPath, shortMarker);
    let owned = true;
    const cleanup = removeLegacyWorkspaceStateForReset(prepare(), {
      assertCurrent: () => {
        if (!owned) {
          throw new Error("cleanup ownership expired");
        }
      },
    });
    owned = false;

    const result = await cleanup;
    expect(result).toMatchObject({
      removedPaths: [],
      warnings: [expect.stringContaining("cleanup ownership expired")],
    });
    expect(await fs.readFile(siblingPath, "utf8")).toBe(shortMarker);
  });

  it.each(["owned", "preview", "malformed"] as const)(
    "cleans %s legacy candidates",
    async (kind) => {
      await fs.mkdir(workspaceDir, { recursive: true });
      const setupPath = paths.setupStatePaths[0]!;
      const statePath = paths.stateDirAttestationPaths[0]!;
      const lastStateClaim = paths.stateDirAttestationPaths.at(-1)! + ".doctor-importing";
      const sibling = paths.siblingAttestationPaths[0]!;
      const candidates =
        kind === "malformed"
          ? [statePath, lastStateClaim]
          : kind === "preview"
            ? [setupPath, sibling]
            : [
                setupPath,
                setupPath + ".doctor-importing",
                statePath,
                lastStateClaim,
                sibling,
                sibling + ".doctor-importing",
              ];
      await writeCandidates(candidates, kind === "malformed" ? "truncated marker\n" : undefined);
      const result = await removeLegacyWorkspaceStateForReset(prepare(), {
        dryRun: kind === "preview",
      });
      expect(result.warnings).toEqual([]);
      expect(new Set(result.removedPaths)).toEqual(new Set(candidates));
      if (kind === "preview") {
        for (const candidate of candidates) {
          await expect(fs.lstat(candidate)).resolves.toBeDefined();
        }
      } else {
        await expectMissing(candidates);
      }
    },
  );

  it("preserves a malformed sibling claim and foreign marker", async () => {
    const siblingPath = paths.siblingAttestationPaths[0]!;
    const claimPath = `${siblingPath}.doctor-importing`;
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(siblingPath, "foreign marker\n", "utf8");
    await fs.writeFile(claimPath, "truncated claim\n", "utf8");

    const result = await removeLegacyWorkspaceStateForReset(prepare());
    expect(result).toMatchObject({ warnings: [], removedPaths: [] });
    await expect(fs.readFile(siblingPath, "utf8")).resolves.toBe("foreign marker\n");
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("truncated claim\n");
    expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).not.toThrow();
  });

  it("checks lexical legacy markers separately for aliases of one workspace", async () => {
    const targetDir = await createAlias();
    assertNoUnmigratedWorkspaceState({ workspaceDir: targetDir });
    await fs.writeFile(`${workspaceDir}.attested`, marker, "utf8");

    expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).toThrow(
      /Run openclaw doctor --fix/u,
    );
  });

  it("rechecks every workspace at lifecycle boundaries after runtime cached absence", async () => {
    const workspaceDirs = [workspaceDir, path.join(homeDir, "secondary")];
    const checkReady = () => assertWorkspaceStateMigrationReady({ workspaceDirs, ...options });
    for (const dir of workspaceDirs) {
      await fs.mkdir(dir, { recursive: true });
      assertNoUnmigratedWorkspaceState({ workspaceDir: dir });
      await fs.writeFile(path.join(dir, "openclaw-workspace-state.json"), '{"version":1}');
    }
    expect(checkReady).toThrow(
      `Run openclaw doctor --fix. Legacy workspace setup state requires migration for ${workspaceDirs.join(", ")}.`,
    );
    for (const dir of workspaceDirs) {
      await fs.unlink(path.join(dir, "openclaw-workspace-state.json"));
    }
    expect(checkReady).not.toThrow();
  });

  it("removes canonical legacy paths after the configured symlink is removed", async () => {
    const targetDir = await createAlias();
    const identity = resolveWorkspaceStateIdentity(targetDir);
    const setupPath = path.join(targetDir, "openclaw-workspace-state.json");
    const stateAttestationPath = path.join(
      stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const siblingPath = `${identity.workspacePath}.attested`;
    const candidates = [setupPath, stateAttestationPath, siblingPath];
    await writeCandidates(candidates);

    const plan = prepare();
    await fs.unlink(workspaceDir);
    const result = await removeLegacyWorkspaceStateForReset(plan);

    expect(result.warnings).toEqual([]);
    await expectMissing(candidates);
  });

  it("does not follow a symlinked attestation directory during reset", async () => {
    const markerPath = paths.stateDirAttestationPaths[0]!;
    const externalDir = path.join(homeDir, "external-attestations");
    const externalMarker = path.join(externalDir, path.basename(markerPath));
    await fs.mkdir(path.dirname(path.dirname(markerPath)), { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(externalMarker, marker, "utf8");
    await fs.symlink(externalDir, path.dirname(markerPath));

    const result = await removeLegacyWorkspaceStateForReset(prepare());

    expect(result.warnings.length).toBeGreaterThan(0);
    await expect(fs.readFile(externalMarker, "utf8")).resolves.toContain(
      LEGACY_WORKSPACE_ATTESTATION_HEADER,
    );
  });
});
