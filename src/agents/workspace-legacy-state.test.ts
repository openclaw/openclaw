import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.unstubAllEnvs());

  let homeDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let options: { env: NodeJS.ProcessEnv; homedir: () => string };
  let paths: ReturnType<typeof resolveLegacyWorkspaceSourcePaths>;
  beforeEach(() => {
    homeDir = tempDirs.make("openclaw-workspace-legacy-cleanup-");
    stateDir = path.join(homeDir, "state");
    workspaceDir = path.join(homeDir, "workspace");
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    options = {
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      homedir: () => homeDir,
    };
    paths = resolveLegacyWorkspaceSourcePaths(workspaceDir, options);
  });
  const prepare = () => prepareLegacyWorkspaceStateReset(workspaceDir);

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
    await writeCandidates([siblingPath], shortMarker);
    let owned = true;
    const cleanup = removeLegacyWorkspaceStateForReset(await prepare(), {
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

  it("cleans owned legacy candidates, including malformed reserved state", async () => {
    await fs.mkdir(workspaceDir, { recursive: true });
    const setup = paths.setupStatePaths[0]!;
    const sibling = paths.siblingAttestationPaths[0]!;
    const reserved = [
      paths.stateDirAttestationPaths[0]!,
      paths.stateDirAttestationPaths.at(-1)! + ".doctor-importing",
    ];
    const candidates = [
      setup,
      setup + ".doctor-importing",
      sibling,
      sibling + ".doctor-importing",
      ...reserved,
    ];
    await writeCandidates(candidates);
    await writeCandidates(reserved, "truncated marker\n");
    const preview = await removeLegacyWorkspaceStateForReset(await prepare(), { dryRun: true });
    expect(preview.warnings).toEqual([]);
    expect(new Set(preview.removedPaths)).toEqual(new Set(candidates));
    for (const candidate of candidates) {
      await expect(fs.lstat(candidate)).resolves.toBeDefined();
    }
    // Preview warms the real owner; preparation and removal must keep filesystem work there.
    const calls = {
      lstat: vi.spyOn(fsSync, "lstatSync"),
      stat: vi.spyOn(fsSync, "statSync"),
      realpath: vi.spyOn(fsSync.realpathSync, "native"),
    };
    try {
      const result = await removeLegacyWorkspaceStateForReset(await prepare());
      expect(result.warnings).toEqual([]);
      expect(new Set(result.removedPaths)).toEqual(new Set(candidates));
      expect({
        lstat: calls.lstat.mock.calls.length,
        stat: calls.stat.mock.calls.length,
        realpath: calls.realpath.mock.calls.length,
      }).toEqual({ lstat: 0, stat: 0, realpath: 0 });
    } finally {
      for (const spy of Object.values(calls)) {
        spy.mockRestore();
      }
    }
    await expectMissing(candidates);
  });

  it("preserves a malformed sibling claim and foreign marker", async () => {
    const siblingPath = paths.siblingAttestationPaths[0]!;
    const claimPath = `${siblingPath}.doctor-importing`;
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeCandidates([siblingPath], "foreign marker\n");
    await writeCandidates([claimPath], "truncated claim\n");

    const result = await removeLegacyWorkspaceStateForReset(await prepare());
    expect(result).toMatchObject({ warnings: [], removedPaths: [] });
    await expect(fs.readFile(siblingPath, "utf8")).resolves.toBe("foreign marker\n");
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("truncated claim\n");
    await expect(assertNoUnmigratedWorkspaceState({ workspaceDir })).resolves.toBeUndefined();
  });

  it("checks lexical legacy markers separately for aliases of one workspace", async () => {
    const targetDir = await createAlias();
    await assertNoUnmigratedWorkspaceState({ workspaceDir: targetDir });
    await fs.writeFile(`${workspaceDir}.attested`, marker, "utf8");

    await expect(assertNoUnmigratedWorkspaceState({ workspaceDir })).rejects.toThrow(
      /Run openclaw doctor --fix/u,
    );
  });

  it("rechecks every workspace at lifecycle boundaries after runtime cached absence", async () => {
    const workspaceDirs = [workspaceDir, path.join(homeDir, "secondary")];
    const checkReady = () => assertWorkspaceStateMigrationReady({ workspaceDirs, ...options });
    for (const dir of workspaceDirs) {
      await fs.mkdir(dir, { recursive: true });
      await assertNoUnmigratedWorkspaceState({ workspaceDir: dir });
      await fs.writeFile(path.join(dir, "openclaw-workspace-state.json"), '{"version":1}');
    }
    expect(checkReady).toThrow(
      `Run openclaw doctor --fix. Legacy workspace setup state requires migration for ${workspaceDirs.join(", ")}.`,
    );
    expect(() =>
      assertWorkspaceStateMigrationReady({ workspaceDirs, ...options, operation: "doctor" }),
    ).toThrow("restore the retained setup file or claim from a verified backup");
    for (const dir of workspaceDirs) {
      await fs.unlink(path.join(dir, "openclaw-workspace-state.json"));
    }
    expect(checkReady).not.toThrow();
  });

  it.each(["removed", "retargeted"] as const)(
    "removes captured canonical legacy paths after the configured symlink is %s",
    async (change) => {
      const targetDir = await createAlias();
      const identity = resolveWorkspaceStateIdentity(targetDir);
      const setupPath = path.join(targetDir, "openclaw-workspace-state.json");
      const stateAttestationPath = path.join(
        stateDir,
        "workspace-attestations",
        `${identity.workspaceKey}.attested`,
      );
      const siblingPath = `${targetDir}.attested`;
      const candidates = [setupPath, stateAttestationPath, siblingPath];
      await writeCandidates(candidates);
      const replacement = path.join(homeDir, "replacement-workspace");
      const replacementCandidates = [
        path.join(replacement, "openclaw-workspace-state.json"),
        `${replacement}.attested`,
      ];
      if (change === "retargeted") {
        await writeCandidates(replacementCandidates);
      }

      const plan = await prepare();
      await fs.unlink(workspaceDir);
      if (change === "retargeted") {
        await fs.symlink(
          replacement,
          workspaceDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const result = await removeLegacyWorkspaceStateForReset(plan);

      expect(result.warnings).toEqual([]);
      await expectMissing(candidates);
      if (change === "retargeted") {
        await expect(fs.readFile(replacementCandidates[0]!, "utf8")).resolves.toBe(
          '{"version":1}\n',
        );
        await expect(fs.readFile(replacementCandidates[1]!, "utf8")).resolves.toBe(marker);
      } else {
        await expectMissing([workspaceDir]);
      }
    },
  );

  it("retains replacement root contents with a cleanup warning", async () => {
    const setupPath = path.join(workspaceDir, "openclaw-workspace-state.json");
    await writeCandidates([setupPath]);
    const plan = await prepare();
    const retiredRoot = path.join(homeDir, "retired-workspace");
    await fs.rename(workspaceDir, retiredRoot);
    await writeCandidates([setupPath], "replacement workspace state\n");

    const result = await removeLegacyWorkspaceStateForReset(plan);

    expect(result.removedPaths).not.toContain(setupPath);
    expect(result.warnings).toContainEqual(expect.stringContaining(setupPath));
    await expect(fs.readFile(setupPath, "utf8")).resolves.toBe("replacement workspace state\n");
    await expect(
      fs.readFile(path.join(retiredRoot, path.basename(setupPath)), "utf8"),
    ).resolves.toBe('{"version":1}\n');
  });

  it("does not follow a symlinked attestation directory during reset", async () => {
    const markerPath = paths.stateDirAttestationPaths[0]!;
    const externalDir = path.join(homeDir, "external-attestations");
    const externalMarker = path.join(externalDir, path.basename(markerPath));
    await fs.mkdir(path.dirname(path.dirname(markerPath)), { recursive: true });
    await writeCandidates([externalMarker]);
    await fs.symlink(externalDir, path.dirname(markerPath));

    const result = await removeLegacyWorkspaceStateForReset(await prepare());

    expect(result.warnings.length).toBeGreaterThan(0);
    await expect(fs.readFile(externalMarker, "utf8")).resolves.toContain(
      LEGACY_WORKSPACE_ATTESTATION_HEADER,
    );
  });
});
