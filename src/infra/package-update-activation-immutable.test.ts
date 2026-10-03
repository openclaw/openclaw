import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  recordImmutablePreparedGeneration,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import type {
  ImmutableInstallDescriptor,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const candidateSha = "b".repeat(40);
let parent: string;
let root: string;
let descriptor: ImmutableInstallDescriptor;
let prepared: ImmutablePreparedGeneration;
const identity = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const controlPath = () => resolvePackageActivationControl(resolvePackageActivationAnchor(root));
const journalPath = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    { path: journalPath(), env: process.env },
  );

beforeEach(() => {
  parent = fs.realpathSync(dirs.make("immutable-install-control-"));
  root = path.join(parent, "installation");
  const current = path.join(root, "releases", sha);
  const candidate = path.join(root, "releases", candidateSha);
  fs.mkdirSync(current, { recursive: true, mode: 0o755 });
  fs.mkdirSync(candidate, { mode: 0o755 });
  fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
  // Simulate root-owned release fixtures on unprivileged CI; SQLite and physical
  // inode, pointer, permission, and transaction behavior remain real.
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (
      stat &&
      (String(args[0]) === parent || String(args[0]).startsWith(`${parent}${path.sep}`))
    ) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  descriptor = {
    version: 1,
    kind: "immutable",
    root,
    rootIdentity: identity(root),
    releasesIdentity: identity(path.join(root, "releases")),
    current: {
      sha,
      path: current,
      identity: identity(current),
      pointerIdentity: identity(path.join(root, "current")),
      buildDigest: "1".repeat(64),
    },
    service: {
      unit: "openclaw-fixture.service",
      scope: "system",
      account: "openclaw-fixture",
      stateDir: path.join(parent, "state"),
      configPath: path.join(parent, "state", "openclaw.json"),
      profile: null,
    },
    runtime: { path: process.execPath, identity: "1:2:3:4:5" },
    source: "https://github.com/openclaw/openclaw.git",
  };
  prepared = {
    sha: candidateSha,
    path: candidate,
    identity: identity(candidate),
    buildDigest: "2".repeat(64),
    preparedAtMs: 1234,
  };
});

afterEach(() => vi.restoreAllMocks());

it("does not adopt a release layout when inspecting an absent record", async () => {
  expect(await readImmutableInstallRecord(root)).toBeNull();
  expect(fs.readdirSync(parent)).toEqual(["installation"]);
});

it("persists adoption and preparation without changing the selected generation", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  expect(read()).toEqual({ revision: 0, descriptor, prepared: null });
  const receipt = recordImmutablePreparedGeneration(adopted, prepared, () => {});
  expect(receipt).toEqual({ revision: 1, descriptor, prepared });
  expect(read()).toEqual(receipt);
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(fs.statSync(controlPath()).mode & 0o777).toBe(0o755);
  expect(fs.statSync(journalPath()).mode & 0o777).toBe(0o644);
});

it("rejects a stale preparation instead of replacing a newer receipt", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  const receipt = recordImmutablePreparedGeneration(adopted, prepared, () => {});
  expect(() =>
    recordImmutablePreparedGeneration(
      adopted,
      {
        ...prepared,
        buildDigest: "3".repeat(64),
      },
      () => {},
    ),
  ).toThrow("no longer current");
  expect(read()).toEqual(receipt);
});

it("rolls back a preparation when executor authority is lost before commit", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  let admissions = 0;
  expect(() =>
    recordImmutablePreparedGeneration(adopted, prepared, () => {
      if (++admissions === 3) {
        throw new Error("executor ended");
      }
    }),
  ).toThrow("executor ended");
  expect(read()).toEqual(adopted);
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
});

it("preserves existing package journals for their original recovery owner", () => {
  fs.mkdirSync(controlPath(), { mode: 0o755 });
  const db = new DatabaseSync(journalPath());
  db.exec(
    "CREATE TABLE package_activation (phase TEXT); INSERT INTO package_activation VALUES ('publishing')",
  );
  db.close();
  fs.chmodSync(journalPath(), 0o644);
  const digest = () => createHash("sha256").update(fs.readFileSync(journalPath())).digest("hex");
  const before = digest();
  expect(read).toThrow("remains with its recovery owner");
  expect(() => createImmutableInstallRecord(descriptor, () => {})).toThrow("no existing control");
  expect(digest()).toBe(before);
});

it("rejects a replacement installation and writable control without mutation", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  fs.chmodSync(journalPath(), 0o666);
  expect(() => recordImmutablePreparedGeneration(adopted, prepared, () => {})).toThrow(
    "unsafe ownership or permissions",
  );
  fs.chmodSync(journalPath(), 0o644);
  expect(read()).toEqual(adopted);
  fs.renameSync(root, `${root}.retained`);
  fs.mkdirSync(root, { mode: 0o755 });
  expect(read).toThrow("does not match the installation");
});

it("refuses a prepared receipt outside its adopted release root", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  expect(() =>
    recordImmutablePreparedGeneration(
      adopted,
      {
        ...prepared,
        path: path.join(parent, candidateSha),
      },
      () => {},
    ),
  ).toThrow("outside its recorded release root");
  expect(read()).toEqual(adopted);
});
