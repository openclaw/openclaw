import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runHeadlessEmulatorProof,
  type SnesHeadlessEmulatorAdapter,
} from "../../scripts/dev/snes-emulator-headless-proof.ts";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeRom(path: string) {
  writeFileSync(path, Buffer.from("OPENCLAW SNES TEST ROM"));
}

function pngBytes(extra = [1, 2, 3, 4]) {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    ...extra,
    ...Array.from({ length: 32 }, (_, index) => index & 0xff),
  ]);
}

function spawnResult(status: number): SpawnSyncReturns<Buffer> {
  return {
    output: [null, Buffer.from("stdout"), Buffer.from("stderr")],
    pid: 123,
    signal: null,
    status,
    stderr: Buffer.from("stderr"),
    stdout: Buffer.from("stdout"),
  };
}

function adapter(id = "fake"): SnesHeadlessEmulatorAdapter {
  return {
    id,
    executablePath: `/bin/${id}`,
    command: ({ romPath, screenshotPath }) => ({
      args: ["--rom", romPath, "--screenshot", screenshotPath],
      command: `/bin/${id}`,
    }),
  };
}

describe("snes-emulator-headless-proof", () => {
  it("passes only when an adapter creates a fresh nonblank PNG for the expected ROM", () => {
    const artifactDir = tempDir("openclaw-snes-headless-pass-");
    const romPath = join(artifactDir, "kata.sfc");
    fakeRom(romPath);

    const receipt = runHeadlessEmulatorProof({
      adapters: [adapter()],
      artifactDir,
      now: "2026-06-26T00:00:00.000Z",
      romPath,
      runner: (_command, args) => {
        const screenshotPath = args.at(-1)!;
        expect(args).toContain(romPath);
        writeFileSync(screenshotPath, pngBytes());
        return spawnResult(0);
      },
    });

    expect(receipt.status).toBe("pass");
    expect(receipt.runtimeSignature.pass).toBe(true);
    expect(receipt.screenshot.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(receipt.screenshot.path!, "utf8").length).toBeGreaterThan(0);
  });

  it("rejects stale screenshots by deleting before each adapter attempt", () => {
    const artifactDir = tempDir("openclaw-snes-headless-stale-");
    const romPath = join(artifactDir, "kata.sfc");
    fakeRom(romPath);
    writeFileSync(join(artifactDir, "fake.boot.png"), pngBytes());

    const receipt = runHeadlessEmulatorProof({
      adapters: [adapter()],
      artifactDir,
      romPath,
      runner: () => spawnResult(0),
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.attempts[0].blocker).toBe(
      "Emulator exited cleanly but did not create a screenshot.",
    );
  });

  it("rejects blank or non-PNG screenshots", () => {
    const artifactDir = tempDir("openclaw-snes-headless-blank-");
    const romPath = join(artifactDir, "kata.sfc");
    fakeRom(romPath);

    const receipt = runHeadlessEmulatorProof({
      adapters: [adapter()],
      artifactDir,
      romPath,
      runner: (_command, args) => {
        writeFileSync(args.at(-1)!, Buffer.alloc(64));
        return spawnResult(0);
      },
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.attempts[0].blocker).toBe("Screenshot is not a PNG file.");
  });

  it("rejects emulator commands that exit nonzero", () => {
    const artifactDir = tempDir("openclaw-snes-headless-nonzero-");
    const romPath = join(artifactDir, "kata.sfc");
    fakeRom(romPath);

    const receipt = runHeadlessEmulatorProof({
      adapters: [adapter()],
      artifactDir,
      romPath,
      runner: () => spawnResult(7),
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.attempts[0]).toMatchObject({
      blocker: "Emulator exited with status 7.",
      exitCode: 7,
      status: "blocked",
    });
  });

  it("rejects wrong ROM hashes before emulator execution", () => {
    const artifactDir = tempDir("openclaw-snes-headless-wrong-rom-");
    const romPath = join(artifactDir, "kata.sfc");
    fakeRom(romPath);

    const receipt = runHeadlessEmulatorProof({
      adapters: [adapter()],
      artifactDir,
      expectedRomSha256: "0".repeat(64),
      romPath,
      runner: () => {
        throw new Error("runner must not execute for wrong ROM hash");
      },
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.blocker).toContain("ROM SHA mismatch");
    expect(receipt.attempts).toEqual([]);
  });
});
