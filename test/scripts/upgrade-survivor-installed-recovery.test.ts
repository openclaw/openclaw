import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  assertPackageTree,
  capturePackageTree,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runProcess } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();

// The installed cell is Linux; use real POSIX modes and direct renames while
// keeping the portable comparator/diagnostic coverage below active on Windows.
it.skipIf(process.platform === "win32")(
  "observes exact permission tightening across package renames and preserves every entry",
  () => {
    const directory = dirs.make("installed-recovery-permissions-");
    const observations = pathToFileURL(
      path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
    ).href;
    const result = runProcess(
      node,
      [
        "--input-type=module",
        "-e",
        `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { capturePackageTree, assertPackageTree } from ${JSON.stringify(observations)};
        const directory = ${JSON.stringify(directory)};
        const original = path.join(directory, 'original');
        const displaced = path.join(directory, 'previous');
        fs.mkdirSync(path.join(original, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(original, 'payload'), 'package bytes');
        fs.linkSync(path.join(original, 'payload'), path.join(original, 'alias'));
        fs.symlinkSync('payload', path.join(original, 'entry'));
        fs.writeFileSync(path.join(original, 'node_modules/.package-lock.json'), 'hidden cache');
        fs.chmodSync(original, 0o755);
        fs.chmodSync(path.join(original, 'node_modules'), 0o750);
        fs.chmodSync(path.join(original, 'payload'), 0o644);
        fs.chmodSync(path.join(original, 'node_modules/.package-lock.json'), 0o664);
        const before = capturePackageTree(original);
        assert(before.some(entry => entry.path === ''));
        assert(before.some(entry => entry.path === 'node_modules/.package-lock.json'));
        assert.equal(before.find(entry => entry.path === 'payload').identity,
          before.find(entry => entry.path === 'alias').identity);
        assert.throws(() => assertPackageTree(before, before, { tightenPermissions: true }), /mode/);
        for (const entry of before) {
          if (entry.kind !== 'link') fs.chmodSync(path.join(original, entry.path), entry.mode & 0o7700);
        }
        fs.renameSync(original, displaced);
        const after = capturePackageTree(displaced);
        assert.throws(() => assertPackageTree(before, after), /mode/);
        assert.equal(assertPackageTree(before, after, { tightenPermissions: true }), after);
        assertPackageTree(after, capturePackageTree(displaced));
        fs.chmodSync(path.join(displaced, 'payload'), 0o644);
        assert.throws(() => assertPackageTree(after, capturePackageTree(displaced)), /mode/);
        fs.chmodSync(path.join(displaced, 'payload'), 0o600);
        for (const [name, contents] of [['payload', 'different bytes'],
          ['node_modules/.package-lock.json', 'different cache']]) {
          const file = path.join(displaced, name);
          const bytes = fs.readFileSync(file);
          const expected = capturePackageTree(displaced);
          fs.writeFileSync(file, contents);
          assert.throws(() => assertPackageTree(expected, capturePackageTree(displaced)), /content/);
          fs.writeFileSync(file, bytes);
        }
        const linked = capturePackageTree(displaced);
        fs.unlinkSync(path.join(displaced, 'entry'));
        fs.symlinkSync('alias', path.join(displaced, 'entry'));
        assert.throws(() => assertPackageTree(linked, capturePackageTree(displaced)), /link target/);
        const complete = capturePackageTree(displaced);
        fs.writeFileSync(path.join(displaced, 'unexpected'), 'new bytes');
        assert.throws(() => assertPackageTree(complete, capturePackageTree(displaced)), /added/);
        fs.unlinkSync(path.join(displaced, 'unexpected'));
        fs.unlinkSync(path.join(displaced, 'alias'));
        assert.throws(() => assertPackageTree(complete, capturePackageTree(displaced)), /removed/);
        assert.throws(() => capturePackageTree(displaced, { maxEntries: 1 }), /entry budget/);
        assert.throws(() => capturePackageTree(displaced, { maxBytes: 1 }), /byte budget/);
      `,
      ],
      { ...process.env, NODE_OPTIONS: "" },
      10_000,
    );
    expect(result.status, result.stderr).toBe(0);
  },
);

it("rejects owner, special-bit, alias and partial-mode drift at the tightening boundary", () => {
  const directory = dirs.make("installed-recovery-metadata-");
  fs.writeFileSync(path.join(directory, "payload"), "package bytes");
  const captured = capturePackageTree(directory);
  const file = captured.find((entry) => entry.path === "payload")!;
  const before = [{ ...file, mode: 0o6755 }];
  const tightened = [{ ...before[0]!, mode: 0o6700 }];
  expect(assertPackageTree(before, tightened, { tightenPermissions: true })).toBe(tightened);
  for (const [field, value] of [
    ["uid", `${file.uid}-changed`],
    ["gid", `${file.gid}-changed`],
    ["identity", `${file.identity}-changed`],
    ["kind", "directory"],
    ["content", "changed bytes"],
    ["mode", 0o6600], // Lost owner execute permission.
    ["mode", 0o4700], // Lost a special bit.
    ["mode", 0o6740], // Only partly tightened.
    ["mode", 0o6777], // Widened access.
  ] as const) {
    expect(() =>
      assertPackageTree(before, [{ ...tightened[0]!, [field]: value }], {
        tightenPermissions: true,
      }),
    ).toThrow(field);
  }
  const link = { ...file, kind: "link" as const, mode: 0o777, content: "payload" };
  expect(assertPackageTree([link], [link], { tightenPermissions: true })).toEqual([link]);
  expect(() =>
    assertPackageTree([link], [{ ...link, mode: 0o700 }], { tightenPermissions: true }),
  ).toThrow("mode");
});

it("reports bounded relative drift without truncating the compared inventory or leaking bytes", () => {
  const directory = dirs.make("installed-recovery-differences-");
  for (let index = 0; index < 12; index++) {
    fs.writeFileSync(path.join(directory, `entry-${index}`), "private original contents");
  }
  const before = capturePackageTree(directory);
  for (let index = 0; index < 12; index++) {
    fs.writeFileSync(path.join(directory, `entry-${index}`), "private replacement contents");
  }
  let message = "";
  try {
    assertPackageTree(before, capturePackageTree(directory));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("12 field differences; 7 more");
  expect(message).toContain('"entry-0": content');
  expect(message).not.toContain("private original contents");
  expect(message).not.toContain("private replacement contents");
  expect(message).not.toContain(directory);
  expect(message.length).toBeLessThan(800);
});

it("bounds directory discovery before sorting and closes handles on entry overflow", () => {
  const directory = dirs.make("installed-recovery-entry-budget-");
  const observations = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
  ).href;
  const result = runProcess(
    node,
    [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { capturePackageTree } from ${JSON.stringify(observations)};
      const directory = ${JSON.stringify(directory)};
      const wide = path.join(directory, 'wide');
      const empty = path.join(directory, 'empty');
      const nested = path.join(directory, 'nested');
      fs.mkdirSync(wide);
      fs.mkdirSync(empty);
      for (let index = 63; index >= 0; index--) {
        fs.writeFileSync(path.join(wide, 'entry-' + index), 'bytes');
      }
      const names = Array.from({ length: 64 }, (_, index) => 'entry-' + index);
      assert.deepEqual(capturePackageTree(wide, { maxEntries: 65 }).map(entry => entry.path),
        ['', ...names.toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0)]);
      assert.deepEqual(capturePackageTree(empty, { maxEntries: 1 }).map(entry => entry.path), ['']);
      fs.mkdirSync(path.join(nested, 'z'), { recursive: true });
      fs.mkdirSync(path.join(nested, 'a'));
      fs.writeFileSync(path.join(nested, 'a', 'payload'), 'bytes');
      assert.deepEqual(capturePackageTree(nested, { maxEntries: 4 }).map(entry => entry.path),
        ['', 'a', path.join('a', 'payload'), 'z']);
      const opendir = fs.opendirSync;
      const lstat = fs.lstatSync;
      const handles = [];
      const visited = [];
      let reads = 0;
      fs.opendirSync = (...args) => {
        const handle = opendir(...args);
        const read = handle.readSync.bind(handle);
        handle.readSync = () => { reads++; return read(); };
        handles.push(handle);
        return handle;
      };
      fs.lstatSync = (file, ...args) => {
        visited.push(path.relative(nested, file));
        return lstat(file, ...args);
      };
      try {
        assert.throws(() => capturePackageTree(wide, { maxEntries: 3 }), /entry budget/);
        assert.equal(reads, 3);
        assert.equal(handles.length, 1);
        assert.throws(() => handles[0].readSync(), { code: 'ERR_DIR_CLOSED' });
        reads = 0;
        handles.length = 0;
        visited.length = 0;
        assert.throws(() => capturePackageTree(nested, { maxEntries: 3 }), /entry budget/);
        assert.deepEqual(visited, ['', 'a']);
        assert.equal(reads, 4);
        assert.equal(handles.length, 2);
        for (const handle of handles) {
          assert.throws(() => handle.readSync(), { code: 'ERR_DIR_CLOSED' });
        }
      } finally {
        fs.opendirSync = opendir;
        fs.lstatSync = lstat;
      }
    `,
    ],
    { ...process.env, NODE_OPTIONS: "" },
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
});
