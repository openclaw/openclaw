import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { capturePackageReleaseSlot, switchPackageReleaseLink } from "./package-release-slot.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";

const child = fileURLToPath(
  new URL("./package-update-release-switch.process.test-support.ts", import.meta.url),
);

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-crash-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function crashAt(cut: string, layout: "linked" | "plain") {
  const proc = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(pathToFileURL(child)), cut, dir, layout],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    proc.on("close", (_code, closeSignal) => resolve(closeSignal));
  });
  expect({ signal, stderr }).toMatchObject({ signal: "SIGKILL" });
  expect(JSON.parse(stdout.trim())).toMatchObject({ cut });
  const globalRoot = path.join(dir, "prefix", "lib", "node_modules");
  return {
    slot: path.join(globalRoot, "openclaw"),
    globalRoot,
    previous: path.join(dir, "prefix", "releases", "r1", "lib", "node_modules", "openclaw"),
    candidate: fs.readFileSync(path.join(dir, "candidate"), "utf8"),
    temporaryLinks: () =>
      fs.readdirSync(globalRoot).filter((name) => name.startsWith(".openclaw.release-link-")),
  };
}

const version = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

describe.skipIf(process.platform === "win32")("release switch killed by SIGKILL", () => {
  it("before the temporary link: the old release stays selected and nothing is pending", async () => {
    const state = await crashAt("before-temporary-link", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toEqual([]);
    // The unselected candidate is left for collection, complete and untouched.
    expect(version(state.candidate)).toBe("2026.12.1");
  });

  it("after the temporary link and before the rename: the next switch removes the leftover", async () => {
    const state = await crashAt("before-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.previous);
    expect(state.temporaryLinks()).toHaveLength(1);

    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the old link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.candidate),
      assertCurrent: () => {},
    });
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(state.temporaryLinks()).toEqual([]);
  });

  it("after the rename and before confirmation: the link names the complete candidate", async () => {
    const state = await crashAt("after-rename", "linked");
    expect(readPackageReleaseSlotSync(state.slot)?.releaseRoot).toBe(state.candidate);
    expect(version(state.slot)).toBe("2026.12.1");
    expect(state.temporaryLinks()).toEqual([]);
    // The next run reads the link; rolling back repeats the switch with the old text.
    const capture = await capturePackageReleaseSlot(state.slot);
    if (capture.kind !== "link") {
      throw new Error("expected the candidate link");
    }
    await switchPackageReleaseLink({
      slot: state.slot,
      expected: capture,
      target: path.relative(state.globalRoot, state.previous),
      assertCurrent: () => {},
    });
    expect(version(state.slot)).toBe("2026.11.3");
  });

  it("between the adoption renames: the leftover link names the unchanged old tree", async () => {
    const state = await crashAt("adoption-window", "plain");
    expect(fs.lstatSync(state.slot, { throwIfNoEntry: false })).toBeUndefined();
    const [leftover] = state.temporaryLinks();
    expect(leftover).toBeDefined();
    // The documented recovery: rename the leftover link onto the package path.
    fs.renameSync(path.join(state.globalRoot, leftover!), state.slot);
    expect(readPackageReleaseSlotSync(state.slot)).not.toBeNull();
    expect(version(state.slot)).toBe("2026.11.3");
    expect(fs.readlinkSync(path.join(dir, "prefix", "bin", "openclaw"))).toBe(
      "../lib/node_modules/openclaw/openclaw.mjs",
    );
  });
});
