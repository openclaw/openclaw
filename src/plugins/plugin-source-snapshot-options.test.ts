import { afterEach, expect, it } from "vitest";
import { pluginSourceSnapshotOptionsDigest } from "./plugin-source-snapshot-options.js";

const original = process.execArgv;
afterEach(() => {
  process.execArgv = original;
});

it("binds snapshots to effective resolution conditions without incidental worker flags", () => {
  process.execArgv = ["--conditions", "custom", "--inspect=0"];
  const custom = pluginSourceSnapshotOptionsDigest({});
  process.execArgv = ["--conditions=custom", "--conditions=custom"];
  expect(pluginSourceSnapshotOptionsDigest({})).toBe(custom);
  process.execArgv = ["-C", "custom"];
  expect(pluginSourceSnapshotOptionsDigest({})).toBe(custom);
  process.execArgv = [];
  const ordinary = pluginSourceSnapshotOptionsDigest({});
  expect(ordinary).not.toBe(custom);
  process.execArgv = ["--conditions=bun"];
  expect(pluginSourceSnapshotOptionsDigest({})).not.toBe(ordinary);
  process.execArgv = ["--no-addons"];
  expect(pluginSourceSnapshotOptionsDigest({})).not.toBe(ordinary);
});

it("binds snapshots to symlink resolution without keying the host main entry", () => {
  process.execArgv = [];
  const ordinary = pluginSourceSnapshotOptionsDigest({});
  process.execArgv = ["--preserve-symlinks-main"];
  expect(pluginSourceSnapshotOptionsDigest({})).toBe(ordinary);
  process.execArgv = ["--preserve-symlinks"];
  expect(pluginSourceSnapshotOptionsDigest({})).not.toBe(ordinary);
});
