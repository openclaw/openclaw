import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultSnesStudioProject,
  createSnesSramImage,
  writeSnesSaveSlot,
} from "../../packages/snes-studio-core/src/index.ts";
import {
  detectSnesEmulatorExecutables,
  runSnesHardwareProof,
} from "../../scripts/dev/snes-studio-hardware-proof.ts";

describe("snes-studio-hardware-proof", () => {
  it("detects user-local macOS emulator apps without requiring sudo installation", () => {
    const detected = detectSnesEmulatorExecutables(
      {
        HOME: "/Users/openclaw",
        PATH: "/opt/homebrew/bin:/usr/local/bin",
      },
      (path) => path === "/Users/openclaw/Applications/Snes9x.app/Contents/MacOS/Snes9x",
      "darwin",
    );

    expect(detected.snes9x).toBe("/Users/openclaw/Applications/Snes9x.app/Contents/MacOS/Snes9x");
  });

  it("writes blocked proof artifacts when no emulator or FXPAK volume is available", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-blocked-"));
    const summary = runSnesHardwareProof({
      artifactDir,
      availableEmulators: [],
      detectedVolumes: [],
      now: "2026-05-21T00:00:00.000Z",
    });

    expect(summary.ok).toBe(false);
    expect(summary.ci).toEqual({
      conclusion: "artifact-ready",
      completeHardwareRequired: false,
      note: "Hardware proof artifacts were generated. Missing emulator execution, FXPAK card, or SRAM after-image evidence is reported as explicit non-blocking readiness state unless --require-complete is used.",
    });
    expect(summary.emulator.status).toBe("blocked");
    expect(summary.fxpak.status).toBe("blocked");
    expect(summary.sram.status).toBe("blocked");
    expect(summary.emulator.blocker).toBe(
      "No supported SNES emulator was detected for boot/screenshot validation.",
    );
    expect(summary.blockers).toContain(
      "No mounted FXPAK PRO or SD2SNES-style FAT32 volume was detected.",
    );
    expect(existsSync(summary.rom.path)).toBe(true);
    expect(existsSync(summary.emulator.proofPath)).toBe(true);
    expect(existsSync(summary.fxpak.dryRunPath)).toBe(true);
    expect(existsSync(summary.hardwareQaBundlePath)).toBe(true);
  });

  it("keeps CI artifact-only CLI proof non-blocking unless complete hardware proof is required", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-cli-"));
    const args = [
      "--import",
      "tsx",
      "scripts/dev/snes-studio-hardware-proof.ts",
      "--artifact-dir",
      artifactDir,
    ];

    const ciResult = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_SNES_STUDIO_FXPAK_VOLUME: "",
      },
    });
    expect(ciResult.status).toBe(0);
    const ciSummary = JSON.parse(ciResult.stdout) as {
      ci: { conclusion: string; completeHardwareRequired: boolean };
      ok: boolean;
    };
    expect(ciSummary.ok).toBe(false);
    expect(ciSummary.ci).toMatchObject({
      completeHardwareRequired: false,
      conclusion: "artifact-ready",
    });

    const requiredResult = spawnSync(process.execPath, [...args, "--require-complete"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_SNES_STUDIO_FXPAK_VOLUME: "",
      },
    });
    expect(requiredResult.status).toBe(2);
    const requiredSummary = JSON.parse(requiredResult.stdout) as {
      ci: { conclusion: string; completeHardwareRequired: boolean };
      ok: boolean;
    };
    expect(requiredSummary.ok).toBe(false);
    expect(requiredSummary.ci).toMatchObject({
      completeHardwareRequired: false,
      conclusion: "artifact-ready",
    });
  });

  it("copies ROM bytes to a simulated FXPAK volume and verifies SRAM after-image proof", () => {
    const now = "2026-05-21T00:00:00.000Z";
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-ready-"));
    const volumePath = mkdtempSync(join(tmpdir(), "FXPAK-"));
    const project = createDefaultSnesStudioProject(now);
    const afterSramPath = join(artifactDir, "after.srm");
    const afterSram = writeSnesSaveSlot(project, createSnesSramImage(project), 0, {
      bosscleared: true,
      checkpoint: 1,
      coins: 1,
    });
    writeFileSync(afterSramPath, afterSram);

    const summary = runSnesHardwareProof({
      afterSramPath,
      artifactDir,
      availableEmulators: ["snes9x"],
      copyFxpak: true,
      detectedVolumes: [
        {
          cardSizeGb: 128,
          existingSavePresent: true,
          fileSystem: "FAT32",
          freeBytes: 4 * 1024 * 1024,
          mounted: true,
          volumePath,
        },
      ],
      now,
      project,
    });
    const copyProof = JSON.parse(readFileSync(summary.fxpak.copyProofPath, "utf8")) as {
      status: string;
      byteContentMatched: boolean;
    };

    expect(summary.fxpak.status).toBe("ready");
    expect(summary.fxpak.copiedRomPath).toBe(`${volumePath}/SNES/OpenClaw/moonlit-ridge.sfc`);
    expect(existsSync(summary.fxpak.copiedRomPath)).toBe(true);
    expect(copyProof.status).toBe("verified");
    expect(copyProof.byteContentMatched).toBe(true);
    expect(summary.sram.status).toBe("verified");
    expect(summary.emulator.status).toBe("ready-to-run");
    expect(summary.ok).toBe(false);
    expect(summary.ci.conclusion).toBe("artifact-ready");
  });

  it("runs an emulator command through the detected executable path and verifies a screenshot baseline", () => {
    const now = "2026-05-21T00:00:00.000Z";
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-emulator-"));
    const baselinePath = join(artifactDir, "baseline.png");
    const screenshotBytes = Buffer.from([0, 1, 2, 4, 8, 16, 32, 64]);
    const emulatorPath = "/Applications/Snes9x.app/Contents/MacOS/Snes9x";
    writeFileSync(baselinePath, screenshotBytes);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner = (
      command: string,
      args: string[],
      options: { cwd: string },
    ): SpawnSyncReturns<Buffer> => {
      commands.push({ args, command });
      const screenshotFileName = args.find((arg) => arg.endsWith(".png"));
      expect(screenshotFileName).toBeTruthy();
      writeFileSync(join(options.cwd, screenshotFileName!), screenshotBytes);
      return {
        output: [null, Buffer.from("boot ok"), Buffer.alloc(0)],
        pid: 123,
        signal: null,
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("boot ok"),
      };
    };

    const summary = runSnesHardwareProof({
      artifactDir,
      availableEmulators: ["snes9x"],
      emulatorExecutables: { snes9x: emulatorPath },
      expectedScreenshotPath: baselinePath,
      now,
      runEmulator: true,
      runner,
    });
    const screenshotComparison = JSON.parse(
      readFileSync(summary.emulator.screenshotComparisonPath, "utf8"),
    ) as {
      status: string;
      screenshotBytes: number;
      expectedChecksum: number | null;
    };

    expect(commands).toEqual([
      {
        args: ["-snapshot", "moonlit-ridge.boot.png", "moonlit-ridge.sfc"],
        command: emulatorPath,
      },
    ]);
    expect(summary.emulator.status).toBe("verified");
    expect(summary.ci.conclusion).toBe("artifact-ready");
    expect(summary.emulator.selectedExecutable).toBe(emulatorPath);
    expect(screenshotComparison.status).toBe("verified");
    expect(screenshotComparison.screenshotBytes).toBe(screenshotBytes.byteLength);
    expect(screenshotComparison.expectedChecksum).not.toBeNull();
  });

  it("marks CI proof complete only when emulator, FXPAK, and SRAM evidence all verify", () => {
    const now = "2026-05-21T00:00:00.000Z";
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-complete-"));
    const volumePath = mkdtempSync(join(tmpdir(), "FXPAK-"));
    const project = createDefaultSnesStudioProject(now);
    const afterSramPath = join(artifactDir, "after.srm");
    const screenshotBytes = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15]);
    const baselinePath = join(artifactDir, "baseline.png");
    writeFileSync(baselinePath, screenshotBytes);
    writeFileSync(
      afterSramPath,
      writeSnesSaveSlot(project, createSnesSramImage(project), 0, {
        bosscleared: true,
        checkpoint: 1,
        coins: 1,
      }),
    );

    const summary = runSnesHardwareProof({
      afterSramPath,
      artifactDir,
      availableEmulators: ["snes9x"],
      copyFxpak: true,
      detectedVolumes: [
        {
          cardSizeGb: 128,
          existingSavePresent: false,
          fileSystem: "FAT32",
          freeBytes: 4 * 1024 * 1024,
          mounted: true,
          volumePath,
        },
      ],
      emulatorExecutables: { snes9x: "/Applications/Snes9x.app/Contents/MacOS/Snes9x" },
      expectedScreenshotPath: baselinePath,
      now,
      project,
      runEmulator: true,
      runner: (_command, args, options): SpawnSyncReturns<Buffer> => {
        const screenshotFileName = args.find((arg) => arg.endsWith(".png"));
        expect(screenshotFileName).toBeTruthy();
        writeFileSync(join(options.cwd, screenshotFileName!), screenshotBytes);
        return {
          output: [null, Buffer.from("boot ok"), Buffer.alloc(0)],
          pid: 123,
          signal: null,
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from("boot ok"),
        };
      },
    });

    expect(summary.ok).toBe(true);
    expect(summary.blockers).toEqual([]);
    expect(summary.ci).toEqual({
      conclusion: "complete",
      completeHardwareRequired: true,
      note: "Full emulator, screenshot, FXPAK copy, and SRAM power-cycle proof completed.",
    });
  });

  it("times out noninteractive emulator proof attempts instead of hanging", () => {
    const now = "2026-05-21T00:00:00.000Z";
    const artifactDir = mkdtempSync(join(tmpdir(), "openclaw-snes-proof-timeout-"));
    const timeoutError = new Error("spawnSync Snes9x ETIMEDOUT");
    const runner = (): SpawnSyncReturns<Buffer> => ({
      error: timeoutError,
      output: [null, Buffer.alloc(0), Buffer.alloc(0)],
      pid: 123,
      signal: "SIGTERM",
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const summary = runSnesHardwareProof({
      artifactDir,
      availableEmulators: ["snes9x"],
      emulatorExecutables: {
        snes9x: "/Users/openclaw/Applications/Snes9x.app/Contents/MacOS/Snes9x",
      },
      emulatorTimeoutMs: 25,
      now,
      runEmulator: true,
      runner,
    });
    const emulatorProof = JSON.parse(readFileSync(summary.emulator.proofPath, "utf8")) as {
      status: string;
      evidence: { elapsedMs: number | null; exitCode: number | null };
    };

    expect(summary.emulator.status).toBe("failed");
    expect(summary.emulator.blocker).toBe("Emulator exited with a non-zero code.");
    expect(emulatorProof.status).toBe("failed");
    expect(emulatorProof.evidence.exitCode).toBe(1);
  });
});
