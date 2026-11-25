import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { isIrohBuildCurrent } from "../../scripts/build-iroh.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rebuilds missing/stale bindings and skips only binaries newer than all native inputs", () => {
  const root = tempDirs.make("iroh-build-");
  const binary = "iroh-node.test.node";
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "package.json",
    "rust-toolchain.toml",
    "src/nested/lib.rs",
  ];
  mkdirSync(path.join(root, "src/nested"), { recursive: true });
  const stamp = (name: string, seconds: number) =>
    utimesSync(path.join(root, name), seconds, seconds);
  for (const name of inputs) {
    writeFileSync(path.join(root, name), "fixture");
    stamp(name, 100);
  }
  stamp("src/nested", 100);
  stamp("src", 100);
  expect(isIrohBuildCurrent(root, binary)).toBe(false);
  writeFileSync(path.join(root, binary), "native fixture");
  stamp(binary, 200);
  expect(isIrohBuildCurrent(root, binary)).toBe(true);
  for (const name of inputs) {
    stamp(name, 300);
    expect(isIrohBuildCurrent(root, binary), name).toBe(false);
    stamp(name, 100);
  }
  stamp("Cargo.toml", 200);
  expect(isIrohBuildCurrent(root, binary)).toBe(false);
  stamp("Cargo.toml", 100);
  unlinkSync(path.join(root, "src/nested/lib.rs"));
  expect(isIrohBuildCurrent(root, binary)).toBe(false);
  expect(isIrohBuildCurrent(root, "iroh-node.other-platform.node")).toBe(false);
});
