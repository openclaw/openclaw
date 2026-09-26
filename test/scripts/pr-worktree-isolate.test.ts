import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createProvisionOwnerFixture,
  expectProvisionSeed,
} from "./pr-worktree-owner.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const intentRef = "refs/openclaw/pr-worktree-isolations/42";
const lockRef = "refs/openclaw/pr-operation-locks/42";
const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

function preparedFixture() {
  const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-isolate-"), "native", 4);
  f.git(f.canonical, "checkout", "-qb", "incoming");
  writeFileSync(join(f.canonical, "incoming.txt"), "original incoming\n");
  f.git(f.canonical, "add", "incoming.txt");
  f.git(f.canonical, "commit", "-qm", "test: incoming");
  const incoming = f.git(f.canonical, "rev-parse", "HEAD");
  f.git(f.canonical, "checkout", "-qb", "upstream", f.main);
  writeFileSync(join(f.canonical, "upstream.txt"), "frozen upstream\n");
  f.git(f.canonical, "add", "upstream.txt");
  f.git(f.canonical, "commit", "-qm", "test: upstream");
  const upstream = f.git(f.canonical, "rev-parse", "HEAD");
  const legacy = join(f.canonical, ".worktrees", "pr-42");
  f.git(f.canonical, "worktree", "add", "-b", "pr-42-prep", legacy, incoming);
  f.git(legacy, "merge", "--no-ff", "-m", "test: prepared merge", upstream);
  const head = f.git(legacy, "rev-parse", "HEAD");
  const admin = f.git(legacy, "rev-parse", "--absolute-git-dir");
  const local = join(legacy, ".local");
  mkdirSync(local);
  const artifacts = new Map(
    [
      "review.json",
      "correction-incoming-review.json",
      "correction-review.json",
      "gates.env",
      "prep.env",
    ].map((name) => [name, Buffer.from(`original ${name}\n`)]),
  );
  for (const [name, bytes] of artifacts) {
    writeFileSync(join(local, name), bytes);
  }
  const privateRef = "refs/openclaw/pr-correction-incoming/42";
  f.git(f.canonical, "update-ref", privateRef, incoming);
  const original = {
    head,
    tree: f.git(legacy, "rev-parse", "HEAD^{tree}"),
    parents: [incoming, upstream],
    index: readFileSync(join(admin, "index")),
    inode: statSync(legacy).ino,
    adminInode: statSync(admin).ino,
    privateRef,
  };
  return { ...f, legacy, head, admin, artifacts, original };
}

function expectPreserved(f: ReturnType<typeof preparedFixture>) {
  expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.original.head);
  expect(f.git(f.worktree, "show", "-s", "--format=%P", "HEAD").split(" ")).toEqual(
    f.original.parents,
  );
  expect(f.git(f.worktree, "rev-parse", "HEAD^{tree}")).toBe(f.original.tree);
  expect(f.git(f.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/pr-42-prep");
  expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
  expect(statSync(f.worktree).ino).toBe(f.original.inode);
  expect(statSync(f.admin).ino).toBe(f.original.adminInode);
  expect(f.git(f.worktree, "rev-parse", "--absolute-git-dir")).toBe(f.admin);
  expect(f.git(f.canonical, "rev-parse", f.original.privateRef)).toBe(f.original.parents[0]);
  for (const [name, bytes] of f.artifacts) {
    const retired = name === "gates.env" || name === "prep.env";
    expect(
      readFileSync(join(f.worktree, ".local", retired ? `${name}.before-isolation` : name)),
    ).toEqual(bytes);
    if (retired) {
      expect(existsSync(join(f.worktree, ".local", name))).toBe(false);
    }
  }
  expect(existsSync(f.legacy)).toBe(false);
  expect(f.git(f.canonical, "worktree", "list", "--porcelain")).toContain(
    `worktree ${f.worktree}\n`,
  );
  expect(JSON.parse(f.git(f.canonical, "cat-file", "blob", intentRef)).phase).toBe("complete");
  expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", lockRef)).toBe("");
}

function injectMoveFailure(
  f: ReturnType<typeof preparedFixture>,
  phase: "before" | "links" | "publication",
) {
  const originalPath = f.env.PATH;
  if (!originalPath) {
    throw new Error("The fixture must retain its original Git search path");
  }
  const selected = spawnSync("which", ["git"], { env: f.env, encoding: "utf8" });
  if (selected.status !== 0) {
    throw new Error(`Cannot locate fixture Git: ${selected.stderr}`);
  }
  const realGit = selected.stdout.trim();
  const wrapper = join(f.root, "move-fault-git");
  const moves = join(f.root, "moves.txt");
  const completed = join(f.root, "completed-moves.txt");
  const disabled = join(f.root, "move-fault-disabled");
  writeFileSync(moves, "");
  writeFileSync(completed, "");
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
# A PATH-resolving Git shim must not rediscover this supervisor-injected wrapper.
PATH=${shellQuote(originalPath)}
export PATH
if [ "$#" = 7 ] && [ "$1" = -C ] && [ "$3 $4 $5" = 'worktree move --' ]; then
  printf '%s\\n' move >> ${shellQuote(moves)}
  if [ ! -e ${shellQuote(disabled)} ]; then
    ${phase === "before" ? "exit 71" : phase === "links" ? 'mv "$6" "$7"\n    exit 72' : `${shellQuote(realGit)} "$@"\n    printf 'moved\\n' >> ${shellQuote(completed)}\n    exit 73`}
  fi
  ${shellQuote(realGit)} "$@"
  printf '%s\\n' moved >> ${shellQuote(completed)}
  exit 0
fi
exec ${shellQuote(realGit)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  f.env.OPENCLAW_PR_GIT = wrapper;
  return { moves, completed, disableFault: () => writeFileSync(disabled, "disabled\n") };
}

function injectParentWriteFailure(
  f: ReturnType<typeof createProvisionOwnerFixture>,
  phase: "parent" | "create" | "remove",
) {
  const parent = dirname(f.worktree);
  const receipt = join(f.root, "write-probe.json");
  const preload = join(f.root, "write-probe-failure.mjs");
  const fetches = join(f.root, "admission-fetches.txt");
  const selected = spawnSync("which", ["git"], { env: f.env, encoding: "utf8" });
  expect(selected.status, selected.stderr).toBe(0);
  const wrapper = join(f.root, "admission-git");
  writeFileSync(fetches, "");
  writeFileSync(
    wrapper,
    `#!/bin/sh
PATH=${shellQuote(f.env.PATH ?? "")}
export PATH
for arg in "$@"; do
  if [ "$arg" = fetch ]; then printf 'fetch\\n' >> ${shellQuote(fetches)}; fi
done
exec ${shellQuote(selected.stdout.trim())} "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  f.env.OPENCLAW_PR_GIT = wrapper;
  writeFileSync(
    preload,
    `import fs from "node:fs";
const prefix = ${JSON.stringify(join(parent, ".pr-write-probe-"))};
const receipt = ${JSON.stringify(receipt)};
${
  phase === "parent"
    ? `const mkdir = fs.mkdirSync;
fs.mkdirSync = function (...args) {
  if (args[0] !== ${JSON.stringify(parent)}) return Reflect.apply(mkdir, this, args);
  fs.writeFileSync(receipt, JSON.stringify({phase: "parent"}));
  throw Object.assign(new Error("synthetic parent creation denial"), {code: "EACCES"});
};`
    : ""
}
const create = fs.mkdtempSync;
const remove = fs.rmdirSync;
let owned;
fs.mkdtempSync = function (...args) {
  if (args[0] !== prefix) return Reflect.apply(create, this, args);
  ${
    phase === "create"
      ? `fs.writeFileSync(receipt, JSON.stringify({phase: "create"}));
  throw Object.assign(new Error("synthetic create denial"), {code: "EACCES"});`
      : `owned = Reflect.apply(create, this, args);
  fs.writeFileSync(receipt, JSON.stringify({phase: "remove", owned}));
  return owned;`
  }
};
fs.rmdirSync = function (...args) {
  if (owned && args[0] === owned) {
    throw Object.assign(new Error("synthetic remove denial"), {code: "EPERM"});
  }
  return Reflect.apply(remove, this, args);
};
`,
  );
  f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href} ${f.env.NODE_OPTIONS ?? ""}`;
  return {
    receipt,
    fetches,
    expectFailure(stderr: string) {
      expect(stderr).toContain(parent);
      expect(stderr).toContain(phase === "remove" ? "EPERM" : "EACCES");
      const observed = JSON.parse(readFileSync(receipt, "utf8"));
      expect(observed.phase).toBe(phase);
      if (phase === "remove") {
        expect(dirname(observed.owned)).toBe(parent);
        expect(basename(observed.owned)).toMatch(/^\.pr-write-probe-/);
        expect(stderr).toContain(`Retain failed probe ${observed.owned}`);
        expect(readdirSync(observed.owned)).toEqual([]);
      } else if (phase === "create") {
        expect(readdirSync(parent)).toEqual([]);
      } else {
        expect(existsSync(parent)).toBe(false);
      }
    },
  };
}

function interruptedOriginalFixture(absentStamp = false) {
  const f = preparedFixture();
  if (absentStamp) {
    rmSync(join(f.legacy, ".local", "prep.env"));
  }
  const observer = injectMoveFailure(f, "before");
  const first = f.run("isolate", f.head);
  expect(first.error).toBeUndefined();
  expect(first.status).toBe(1);
  expect(first.stderr).toContain("Native PR isolation Git operation failed");
  expect(JSON.parse(f.git(f.canonical, "cat-file", "blob", intentRef)).phase).toBe("intent");
  const recovered = f.run("recover", f.git(f.canonical, "rev-parse", lockRef));
  expect(recovered.status, recovered.stderr).toBe(0);
  observer.disableFault();
  return { ...f, observer };
}

describePosix("native PR worktree isolation", () => {
  it("preserves the state probe's exact JSON framing for a quoted newline path", () => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-state-"), "native", 4);
    const parent = join(f.root, "legacy-parent-\n'");
    mkdirSync(parent);
    symlinkSync(parent, join(f.canonical, ".worktrees"), "dir");
    const worktree = join(parent, "pr-42");
    f.git(f.canonical, "worktree", "add", "--detach", worktree, f.main);
    const common = join(f.canonical, ".git");
    const admin = f.git(worktree, "rev-parse", "--absolute-git-dir");
    const index = readFileSync(join(admin, "index"));
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        resolve("scripts/pr-lib/worktree-placement.mjs"),
        "state",
        f.canonical,
        common,
        worktree,
        admin,
        "entry",
      ],
      { cwd: f.canonical, env: f.env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      JSON.stringify({
        path: worktree,
        present: true,
        admin,
        common,
        previousAdminPresent: true,
      }) + "\n",
    );
    expect(readFileSync(join(admin, "index"))).toEqual(index);
  });

  it.each(["message", "code"] as const)("preserves the state probe's %s failure", (kind) => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-state-error-"), "native", 4);
    const blocked = join(f.root, "not-a-directory");
    writeFileSync(blocked, "original file\n");
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        resolve("scripts/pr-lib/worktree-placement.mjs"),
        "state",
        f.canonical,
        kind === "code" ? join(blocked, ".git") : join(f.canonical, ".git"),
        kind === "message" ? join(f.root, "foreign", "pr-42") : f.worktree,
        "",
        "cleanup",
      ],
      { cwd: f.canonical, env: f.env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `Refusing PR worktree cleanup: ${kind === "code" ? "ENOTDIR" : "non-canonical PR-worktree path"}\n`,
    );
    expect(readFileSync(blocked, "utf8")).toBe("original file\n");
    expect(existsSync(f.worktree)).toBe(false);
  });

  it("provisions outside the canonical owner's ancestor installation", () => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-isolated-cold-"), "native", 4);
    mkdirSync(join(f.canonical, "node_modules"));
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expectProvisionSeed(f);
    expect(existsSync(join(f.canonical, ".worktrees", "pr-42"))).toBe(false);
    expect(f.worktree.startsWith(`${f.canonical}/`)).toBe(false);
    expect(existsSync(join(f.worktree, "node_modules"))).toBe(false);
    f.isolation.assertProvisioner();
  });

  it("refuses cold creation when the missing sibling parent cannot be created", () => {
    const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-parent-permission-"));
    expect(existsSync(dirname(f.worktree))).toBe(false);
    const probe = injectParentWriteFailure(f, "parent");
    const refs = f.git(f.canonical, "for-each-ref");
    const registration = f.git(f.canonical, "worktree", "list", "--porcelain");
    const index = readFileSync(join(f.canonical, ".git", "index"));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    probe.expectFailure(result.stderr);
    expect(result.stderr).toContain("cold PR creation");
    expect(result.stderr).toContain("EACCES: synthetic parent creation denial");
    expect(readFileSync(probe.fetches, "utf8")).toBe("");
    expect(readFileSync(f.isolation.launches, "utf8")).toBe("");
    expect(f.git(f.canonical, "for-each-ref")).toBe(refs);
    expect(f.git(f.canonical, "for-each-ref", intentRef, lockRef)).toBe("");
    expect(f.git(f.canonical, "worktree", "list", "--porcelain")).toBe(registration);
    expect(readFileSync(join(f.canonical, ".git", "index"))).toEqual(index);
    expect(existsSync(f.worktree)).toBe(false);
    expect(existsSync(join(f.canonical, ".worktrees", "pr-42"))).toBe(false);
  });

  it.each(["create", "remove"] as const)(
    "refuses cold creation when the sibling write probe cannot %s",
    (phase) => {
      const f = createProvisionOwnerFixture(tempDirs.make("openclaw-pr-cold-permission-"));
      const probe = injectParentWriteFailure(f, phase);
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      probe.expectFailure(result.stderr);
      expect(result.stderr).toContain("cold PR creation");
      expect(readFileSync(probe.fetches, "utf8")).toBe("");
      expect(f.git(f.canonical, "for-each-ref", "refs/heads/temp", "refs/openclaw")).toBe("");
      expect(f.git(f.canonical, "worktree", "list", "--porcelain")).not.toContain("pr-42");
      expect(existsSync(f.worktree)).toBe(false);
      expect(existsSync(join(f.canonical, ".worktrees", "pr-42"))).toBe(false);
    },
  );

  it.each(["create", "remove"] as const)(
    "preserves fresh isolation when the sibling write probe cannot %s",
    (phase) => {
      const f = preparedFixture();
      const probe = injectParentWriteFailure(f, phase);
      const result = f.run("isolate", f.head);
      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      probe.expectFailure(result.stderr);
      expect(result.stderr).toContain("native PR isolation");
      expect(existsSync(f.worktree)).toBe(false);
      expect(statSync(f.legacy).ino).toBe(f.original.inode);
      expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
      expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.canonical, "rev-parse", f.original.privateRef)).toBe(f.original.parents[0]);
      for (const [name, bytes] of f.artifacts) {
        expect(readFileSync(join(f.legacy, ".local", name))).toEqual(bytes);
      }
      expect(f.git(f.canonical, "for-each-ref", intentRef, lockRef)).toBe("");
      expect(f.git(f.canonical, "worktree", "list", "--porcelain")).toContain(f.legacy);
    },
  );

  it("reuses a healthy legacy checkout without sibling write admission", () => {
    const f = preparedFixture();
    const probe = injectParentWriteFailure(f, "create");
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(probe.receipt)).toBe(false);
    expect(readFileSync(probe.fetches, "utf8")).not.toBe("");
    expect(statSync(f.legacy).ino).toBe(f.original.inode);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.git(f.canonical, "for-each-ref", intentRef, lockRef)).toBe("");
  });

  it("resolves and lists an aliased legacy parent as one original worktree", () => {
    const f = createProvisionOwnerFixture(
      tempDirs.make("openclaw-pr-isolated-alias-"),
      "native",
      4,
    );
    const first = f.run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const admin = f.git(f.worktree, "rev-parse", "--absolute-git-dir");
    const index = readFileSync(join(admin, "index"));
    const inode = statSync(f.worktree).ino;
    symlinkSync(dirname(f.worktree), join(f.canonical, ".worktrees"), "dir");
    const entered = f.run();
    expect(entered.status, entered.stdout + entered.stderr).toBe(0);
    expectProvisionSeed(f);
    expect(f.git(f.worktree, "rev-parse", "--absolute-git-dir")).toBe(admin);
    expect(readFileSync(join(admin, "index"))).toEqual(index);
    expect(statSync(f.worktree).ino).toBe(inode);
    const listed = f.run("list");
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    expect(listed.stdout.split("\n").filter((line) => line.startsWith("42\t"))).toEqual([
      `42\t${f.worktree}\tMERGED`,
    ]);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", intentRef)).toBe("");
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
  });

  it("refuses genuinely distinct legacy and isolated registrations", () => {
    const f = preparedFixture();
    f.git(f.canonical, "worktree", "add", "-b", "other-pr-42", f.worktree, f.head);
    const otherAdmin = f.git(f.worktree, "rev-parse", "--absolute-git-dir");
    const otherIndex = readFileSync(join(otherAdmin, "index"));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Ambiguous legacy and isolated PR worktrees");
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.legacy, "rev-parse", "--absolute-git-dir")).toBe(f.admin);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.worktree, "rev-parse", "--absolute-git-dir")).toBe(otherAdmin);
    expect(readFileSync(join(otherAdmin, "index"))).toEqual(otherIndex);
    expect(otherAdmin).not.toBe(f.admin);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", intentRef)).toBe("");
    expect(f.git(f.canonical, "rev-parse", lockRef)).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(["absent", "direct"] as const)(
    "accepts traced Git observations of an %s isolation intent",
    (kind) => {
      const f = preparedFixture();
      if (kind === "direct") {
        const moved = f.run("isolate", f.head);
        expect(moved.status, moved.stdout + moved.stderr).toBe(0);
        expectPreserved(f);
      }
      f.env.GIT_TRACE = "1";
      const listed = f.run("list");
      expect(listed.status, listed.stdout + listed.stderr).toBe(0);
      expect(listed.stderr).toContain("trace: built-in: git");
      const expectedPath = kind === "direct" ? f.worktree : f.legacy;
      expect(listed.stdout.split("\n").filter((line) => line.startsWith("42\t"))).toEqual([
        `42\t${kind === "direct" ? expectedPath : ".worktrees/pr-42"}\tMERGED`,
      ]);
      expect(f.git(expectedPath, "rev-parse", "HEAD")).toBe(f.head);
    },
  );

  it.each([
    ["malformed", "not-an-object\n"],
    ["missing-object", `${"a".repeat(40)}\n`],
  ])("refuses a %s direct isolation intent without treating it as absent", (_kind, bytes) => {
    const f = preparedFixture();
    const refPath = join(f.canonical, ".git", intentRef);
    mkdirSync(dirname(refPath), { recursive: true });
    writeFileSync(refPath, bytes);
    f.env.GIT_REF_PARANOIA = "0";
    const result = f.run("list");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot inspect native PR placement:");
    expect(readFileSync(refPath, "utf8")).toBe(bytes);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each(["valid", "dangling"] as const)("refuses a %s symbolic isolation intent", (kind) => {
    const f = preparedFixture();
    const target = kind === "valid" ? f.original.privateRef : "refs/openclaw/missing/42";
    f.git(f.canonical, "symbolic-ref", intentRef, target);
    const result = f.run("list");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("isolation intent must be a direct ref");
    expect(f.git(f.canonical, "symbolic-ref", intentRef)).toBe(target);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(existsSync(f.worktree)).toBe(false);
  });

  it("does not adopt a suffix-only isolation ref match", () => {
    const f = preparedFixture();
    const suffixRef = `refs/tags/${intentRef}`;
    f.git(f.canonical, "update-ref", suffixRef, f.head);
    expect(f.git(f.canonical, "show-ref", "--", intentRef)).toBe(`${f.head} ${suffixRef}`);
    const result = f.run("list");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line.startsWith("42\t"))).toEqual([
      "42\t.worktrees/pr-42\tMERGED",
    ]);
    expect(f.git(f.canonical, "rev-parse", suffixRef)).toBe(f.head);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", intentRef)).toBe("");
  });

  it.each(["truncated", "duplicate", "nonempty-absence"] as const)(
    "refuses a %s isolation ref observation",
    (kind) => {
      const f = preparedFixture();
      const backendPath = f.env.PATH;
      if (!backendPath) {
        throw new Error("The fixture must retain its original Git search path");
      }
      const realGit = spawnSync("which", ["git"], { env: f.env, encoding: "utf8" }).stdout.trim();
      const wrapper = join(f.root, "ref-observation-git");
      const row = `${f.head} ${intentRef}`;
      const output =
        kind === "duplicate" ? `${row}\n${row}\n` : kind === "truncated" ? row : `${row}\n`;
      writeFileSync(
        wrapper,
        `#!/bin/sh
if [ "$#" = 5 ] && [ "$3 $4 $5" = 'show-ref -- ${intentRef}' ]; then
  printf '%s' ${shellQuote(output)}
  exit ${kind === "nonempty-absence" ? 1 : 0}
fi
PATH=${shellQuote(backendPath)} exec ${shellQuote(realGit)} "$@"
`,
      );
      chmodSync(wrapper, 0o755);
      f.env.OPENCLAW_PR_GIT = wrapper;
      const result = f.run("list");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        kind === "duplicate"
          ? "Duplicate native PR isolation intent"
          : "native PR isolation ref observation",
      );
      expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
      expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it("retains the original PR lock across both exact isolation ref queries", () => {
    const f = preparedFixture();
    const backendPath = f.env.PATH;
    if (!backendPath) {
      throw new Error("The fixture must retain its original Git search path");
    }
    const realGit = spawnSync("which", ["git"], { env: f.env, encoding: "utf8" }).stdout.trim();
    const observations = join(f.root, "query-locks");
    const contender = join(f.root, "contender.sh");
    writeFileSync(
      contender,
      `set -uo pipefail
source ${shellQuote(resolve("scripts/pr-lib/worktree.sh"))}
source ${shellQuote(resolve("scripts/pr-lib/common.sh"))}
source ${shellQuote(resolve("scripts/pr-lib/operation-lock.sh"))}
canonical_repo_root=${shellQuote(f.canonical)}
try_acquire_pr_operation_lock 42
status=$?
if [ "$status" = 0 ]; then release_pr_operation_lock || exit 98; fi
exit "$status"
`,
    );
    const wrapper = join(f.root, "query-lock-git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
set -eu
PATH=${shellQuote(backendPath)}
export PATH
if [ "$#" = 5 ] && { [ "$3 $4 $5" = 'symbolic-ref --quiet ${intentRef}' ] || [ "$3 $4 $5" = 'show-ref -- ${intentRef}' ]; }; then
  before=$(${shellQuote(realGit)} -C ${shellQuote(f.canonical)} rev-parse ${shellQuote(lockRef)})
  status=0
  ${shellQuote(process.execPath)} ${shellQuote(resolve("scripts/pr-lib/process-group-runner.mjs"))} ${shellQuote(f.canonical)} ${shellQuote(process.platform === "darwin" ? "/bin/bash" : "bash")} ${shellQuote(contender)} >&2 || status=$?
  after=$(${shellQuote(realGit)} -C ${shellQuote(f.canonical)} rev-parse ${shellQuote(lockRef)})
  printf '%s %s %s %s\\n' "$3" "$before" "$after" "$status" >> ${shellQuote(observations)}
fi
exec ${shellQuote(realGit)} "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    f.env.OPENCLAW_PR_GIT = wrapper;
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const rows = readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    expect(rows.map(([query]) => query)).toEqual(["symbolic-ref", "show-ref"]);
    const originalOwner = rows[0]?.[1];
    expect(originalOwner).toMatch(/^[0-9a-f]{40}$/);
    for (const [, before, after, status] of rows) {
      expect(before).toBe(originalOwner);
      expect(after).toBe(originalOwner);
      expect(status).toBe("1");
    }
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
  });

  it("moves the original prepared merge and preserves review, index and private authority", () => {
    const f = preparedFixture();
    const result = f.run("isolate", f.head);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expectPreserved(f);
  });

  it.for([
    { title: "refuses a live checkout holder without moving its cwd", retained: false },
    { title: "refuses a new holder while recovering the retained original", retained: true },
  ])("$title", async ({ retained }, { signal }) => {
    const interrupted = retained ? interruptedOriginalFixture() : undefined;
    const f = interrupted ?? preparedFixture();
    const intent = f.git(f.canonical, "for-each-ref", "--format=%(objectname)", intentRef);
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `process.on("message", (message) => {
  if (message === "still-held") process.send({ pid: process.pid, cwd: process.cwd() });
});
console.log("held");`,
      ],
      {
        cwd: f.legacy,
        env: f.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const closed = once(holder, "close");
    void closed.catch(() => {});
    try {
      if (holder.stdout === null) {
        throw new Error("Original checkout holder has no readiness pipe");
      }
      const [output] = await once(holder.stdout, "data", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      expect(String(output)).toContain("held");
      const result = f.run("isolate", f.head);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live holders");
      expect(existsSync(f.legacy)).toBe(true);
      expect(existsSync(f.worktree)).toBe(false);
      expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", intentRef)).toBe(intent);
      if (interrupted) {
        expect(readFileSync(interrupted.observer.moves, "utf8")).toBe("move\n");
        expect(f.git(f.canonical, "rev-parse", lockRef)).toMatch(/^[0-9a-f]{40}$/);
      }
      const holderPid = holder.pid;
      if (holderPid === undefined) {
        throw new Error("Original checkout holder did not start");
      }
      const acknowledged = once(holder, "message", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      void acknowledged.catch(() => {});
      holder.send("still-held");
      const [message] = await acknowledged;
      expect(message).toEqual({ pid: holderPid, cwd: f.legacy });
      expect(process.kill(holderPid, 0)).toBe(true);
      expect(holder.exitCode).toBeNull();
      expect(holder.signalCode).toBeNull();
    } finally {
      holder.kill("SIGTERM");
      await closed;
    }
  });

  it("refuses an ambiguous destination without adopting or deleting it", () => {
    const f = preparedFixture();
    mkdirSync(f.worktree, { recursive: true });
    writeFileSync(join(f.worktree, "foreign.txt"), "foreign owner\n");
    const result = f.run("isolate", f.head);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("absent destination");
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.worktree, "foreign.txt"), "utf8")).toBe("foreign owner\n");
    expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", intentRef)).toBe("");
  });

  it.each(["before", "links", "publication"] as const)(
    "retains original move custody after failure at %s",
    (phase) => {
      const f = preparedFixture();
      const observer = injectMoveFailure(f, phase);
      const result = f.run("isolate", f.head);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Native PR isolation Git operation failed");
      const intent = JSON.parse(f.git(f.canonical, "cat-file", "blob", intentRef));
      expect(intent.phase).toBe("intent");
      expect(intent.head).toBe(f.head);
      expect(existsSync(f.legacy)).toBe(phase === "before");
      expect(existsSync(f.worktree)).toBe(phase !== "before");
      const retainedLock = f.git(f.canonical, "rev-parse", lockRef);
      expect(retainedLock).toMatch(/^[0-9a-f]{40}$/);
      observer.disableFault();
      const recovered = f.run("recover", retainedLock);
      expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
      const completed = f.run("isolate", f.head);
      if (phase === "links") {
        expect(completed.status).not.toBe(0);
        expect(completed.stderr).toContain("stale Git backlink");
        expect(readFileSync(join(f.admin, "gitdir"), "utf8").trim()).toBe(join(f.legacy, ".git"));
        expect(JSON.parse(f.git(f.canonical, "cat-file", "blob", intentRef)).phase).toBe("intent");
      } else {
        expect(completed.status, completed.stdout + completed.stderr).toBe(0);
        expectPreserved(f);
        const repeated = f.run("isolate", f.head);
        expect(repeated.status, repeated.stderr).toBe(0);
        expectPreserved(f);
      }
      expect(readFileSync(observer.moves, "utf8")).toBe(
        phase === "before" ? "move\nmove\n" : "move\n",
      );
      expect(readFileSync(observer.completed, "utf8")).toBe(phase === "links" ? "" : "moved\n");
    },
  );

  it("retains original recovery custody when the initial intent query fails", () => {
    const f = interruptedOriginalFixture();
    const intent = f.git(f.canonical, "rev-parse", intentRef);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", lockRef)).toBe("");
    const originalGit = f.env.OPENCLAW_PR_GIT;
    const originalPath = f.env.PATH;
    if (!originalGit || !originalPath) {
      throw new Error("The fixture must retain its original Git observer and search path");
    }
    const observed = join(f.root, "initial-intent-query.txt");
    const wrapper = join(f.root, "intent-query-failure-git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
PATH=${shellQuote(originalPath)}
export PATH
if [ "$#" = 5 ] && [ "$1" = -C ] && [ "$2" = ${shellQuote(f.canonical)} ] &&
  [ "$3" = for-each-ref ] && [ "$4" = '--format=%(refname) %(objectname)' ] && [ "$5" = ${shellQuote(intentRef)} ]; then
  printf 'initial-intent-query\\n' >> ${shellQuote(observed)}
  printf 'synthetic initial intent read failure (EACCES)\\n' >&2
  exit 74
fi
exec ${shellQuote(originalGit)} "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    f.env.OPENCLAW_PR_GIT = wrapper;
    const result = f.run("isolate", f.head);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(
      "Native PR isolation Git operation failed: synthetic initial intent read failure (EACCES)",
    );
    expect(readFileSync(observed, "utf8")).toBe("initial-intent-query\n");
    expect(f.git(f.canonical, "rev-parse", intentRef)).toBe(intent);
    expect(f.git(f.canonical, "rev-parse", lockRef)).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(f.observer.moves, "utf8")).toBe("move\n");
    expect(readFileSync(f.observer.completed, "utf8")).toBe("");
    expect(statSync(f.legacy).ino).toBe(f.original.inode);
    expect(statSync(f.admin).ino).toBe(f.original.adminInode);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(f.git(f.canonical, "rev-parse", f.original.privateRef)).toBe(f.original.parents[0]);
    for (const [name, bytes] of f.artifacts) {
      expect(readFileSync(join(f.legacy, ".local", name))).toEqual(bytes);
    }
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each([
    "branch",
    "head",
    "index",
    "review",
    "private-ref",
    "directory",
    "admin",
    "changed-stamp",
    "missing-stamp",
    "new-stamp",
    "archive",
    "both",
    "neither",
    "complete-original",
  ] as const)("refuses changed retained-original state (%s)", (change) => {
    const f = interruptedOriginalFixture(change === "new-stamp");
    const local = join(f.legacy, ".local");
    if (change === "branch") {
      f.git(f.canonical, "branch", "pr-42", f.head);
      f.git(f.legacy, "symbolic-ref", "HEAD", "refs/heads/pr-42");
    } else if (change === "head") {
      const incoming = expectDefined(f.original.parents[0], "original incoming parent");
      f.git(f.canonical, "update-ref", "refs/heads/pr-42-prep", incoming, f.head);
    } else if (change === "index") {
      f.git(f.legacy, "update-index", "--assume-unchanged", "incoming.txt");
    } else if (change === "review") {
      writeFileSync(join(local, "review.json"), "successor review\n");
    } else if (change === "private-ref") {
      const upstream = expectDefined(f.original.parents[1], "original upstream parent");
      f.git(f.canonical, "update-ref", f.original.privateRef, upstream);
    } else if (change === "directory" || change === "admin" || change === "neither") {
      const original = change === "admin" ? f.admin : f.legacy;
      renameSync(original, `${original}-retained`);
      if (change !== "neither") {
        cpSync(`${original}-retained`, original, { recursive: true });
      }
    } else if (change === "changed-stamp") {
      writeFileSync(join(local, "gates.env"), "successor gate\n");
    } else if (change === "missing-stamp") {
      rmSync(join(local, "prep.env"));
    } else if (change === "new-stamp") {
      writeFileSync(join(local, "prep.env"), "new path-bound proof\n");
    } else if (change === "archive") {
      writeFileSync(join(local, "prep.env.before-isolation"), "foreign archive\n");
    } else if (change === "both") {
      mkdirSync(f.worktree);
      writeFileSync(join(f.worktree, "foreign.txt"), "foreign destination\n");
    } else {
      const record = JSON.parse(f.git(f.canonical, "cat-file", "blob", intentRef));
      record.phase = "complete";
      const file = join(f.root, "changed-intent.json");
      writeFileSync(file, JSON.stringify(record));
      f.git(f.canonical, "update-ref", intentRef, f.git(f.canonical, "hash-object", "-w", file));
    }
    const intent = f.git(f.canonical, "rev-parse", intentRef);
    const privateRef = f.git(f.canonical, "rev-parse", f.original.privateRef);
    const retainedPaths = [
      f.legacy,
      f.worktree,
      f.admin,
      `${f.legacy}-retained`,
      `${f.admin}-retained`,
    ];
    const directories = () =>
      retainedPaths.map((file) => (existsSync(file) ? statSync(file).ino : null));
    const beforeDirectories = directories();
    const retainedFiles = [
      join(f.admin, "index"),
      join(f.admin, "HEAD"),
      join(f.admin, "gitdir"),
      join(local, "review.json"),
      join(local, "gates.env"),
      join(local, "prep.env"),
      join(local, "prep.env.before-isolation"),
      join(f.worktree, "foreign.txt"),
    ];
    const contents = () =>
      retainedFiles.map((file) => (existsSync(file) ? readFileSync(file) : null));
    const beforeContents = contents();
    const result = f.run("isolate", f.head);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Native PR isolation stopped:");
    expect(readFileSync(f.observer.moves, "utf8")).toBe("move\n");
    expect(readFileSync(f.observer.completed, "utf8")).toBe("");
    expect(f.git(f.canonical, "rev-parse", intentRef)).toBe(intent);
    expect(f.git(f.canonical, "rev-parse", f.original.privateRef)).toBe(privateRef);
    expect(f.git(f.canonical, "rev-parse", lockRef)).toMatch(/^[0-9a-f]{40}$/);
    expect(directories()).toEqual(beforeDirectories);
    expect(contents()).toEqual(beforeContents);
  });

  it.each(["visibility", "lock", "intent"] as const)(
    "retains original recovery custody after %s authority changes",
    (change) => {
      const f = interruptedOriginalFixture();
      const intent = f.git(f.canonical, "rev-parse", intentRef);
      const selected = spawnSync("which", ["lsof"], { env: f.env, encoding: "utf8" });
      expect(selected.status, selected.stderr).toBe(0);
      const replacementFile = join(f.root, "foreign-authority.txt");
      writeFileSync(replacementFile, "foreign authority\n");
      const replacement = f.git(f.canonical, "hash-object", "-w", replacementFile);
      const wrapper = join(f.root, "lsof-bin");
      mkdirSync(wrapper);
      const observed = join(f.root, "lsof-observed.txt");
      writeFileSync(
        join(wrapper, "lsof"),
        `#!/bin/sh
PATH=${shellQuote(f.env.PATH ?? "")}
export PATH
if [ "$5" = ${shellQuote(f.admin)} ]; then
  printf 'original-admin\\n' >> ${shellQuote(observed)}
  ${change === "visibility" ? "exit 2" : `${shellQuote(f.env.OPENCLAW_PR_GIT ?? "git")} -C ${shellQuote(f.canonical)} update-ref --no-deref ${shellQuote(change === "lock" ? lockRef : intentRef)} ${replacement} || exit 3`}
fi
exec ${shellQuote(selected.stdout.trim())} "$@"
`,
      );
      chmodSync(join(wrapper, "lsof"), 0o755);
      f.env.PATH = `${wrapper}${delimiter}${f.env.PATH}`;
      const result = f.run("isolate", f.head);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readFileSync(observed, "utf8")).toBe("original-admin\n");
      expect(result.stderr).toContain(
        change === "visibility"
          ? "Cannot establish native PR checkout holder absence"
          : change === "lock"
            ? "PR operation lock changed"
            : "Retained native isolation intent changed",
      );
      expect(readFileSync(f.observer.moves, "utf8")).toBe("move\n");
      expect(readFileSync(f.observer.completed, "utf8")).toBe("");
      expect(statSync(f.legacy).ino).toBe(f.original.inode);
      expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
      expect(existsSync(f.worktree)).toBe(false);
      expect(f.git(f.canonical, "rev-parse", intentRef)).toBe(
        change === "intent" ? replacement : intent,
      );
      const lock = f.git(f.canonical, "rev-parse", lockRef);
      if (change === "lock") {
        expect(lock).toBe(replacement);
      } else {
        expect(lock).toMatch(/^[0-9a-f]{40}$/);
      }
    },
  );

  it.each(["create", "remove"] as const)(
    "retains intent and the failed recovery lock after a %s probe denial",
    (phase) => {
      const f = interruptedOriginalFixture();
      const intent = f.git(f.canonical, "rev-parse", intentRef);
      const selectedGit = f.env.OPENCLAW_PR_GIT;
      const probe = injectParentWriteFailure(f, phase);
      // Keep the original move observer through recovery; only the FS fault is new.
      f.env.OPENCLAW_PR_GIT = selectedGit;
      const result = f.run("isolate", f.head);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      probe.expectFailure(result.stderr);
      expect(f.git(f.canonical, "rev-parse", intentRef)).toBe(intent);
      expect(f.git(f.canonical, "rev-parse", lockRef)).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(f.observer.moves, "utf8")).toBe("move\n");
      expect(readFileSync(f.observer.completed, "utf8")).toBe("");
      expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
      expect(existsSync(f.legacy)).toBe(true);
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it("refuses a different destination-parent device before recording move intent", () => {
    const f = preparedFixture();
    const parent = dirname(f.worktree);
    mkdirSync(parent);
    const preload = join(f.root, "destination-device.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs";
const original = fs.lstatSync;
fs.lstatSync = function (...args) {
  const value = Reflect.apply(original, this, args);
  if (String(args[0]) === ${JSON.stringify(parent)} && value) value.dev += 1;
  return value;
};
`,
    );
    f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    const result = f.run("isolate", f.head);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("same-filesystem move");
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(statSync(f.legacy).ino).toBe(f.original.inode);
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", intentRef)).toBe("");
  });

  it("refuses retained submodule administration before recording move intent", () => {
    const f = preparedFixture();
    mkdirSync(join(f.admin, "modules"));
    expect(f.git(f.legacy, "ls-files", "--stage")).not.toContain("160000 ");
    const result = f.run("isolate", f.head);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("worktrees with submodules");
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.admin, "index"))).toEqual(f.original.index);
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(objectname)", intentRef)).toBe("");
  });

  it("retains an unresolved isolation while collecting the next eligible PR", () => {
    const f = preparedFixture();
    const eligible = join(f.canonical, ".worktrees", "pr-43");
    f.git(f.canonical, "worktree", "add", "-b", "pr-43", eligible, f.main);
    const record = join(f.root, "isolation-intent.json");
    writeFileSync(
      record,
      JSON.stringify({
        version: 1,
        root: f.canonical,
        pr: "42",
        from: f.legacy,
        to: f.worktree,
        phase: "intent",
      }),
    );
    const oid = f.git(f.canonical, "hash-object", "-w", record);
    f.git(f.canonical, "update-ref", intentRef, oid);
    const result = f.run("gc");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("PR #42 placement is unresolved");
    expect(result.stdout).toContain("removed .worktrees/pr-43");
    expect(f.git(f.canonical, "rev-parse", intentRef)).toBe(oid);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(existsSync(eligible)).toBe(false);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
    expect(
      f.git(
        f.canonical,
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/pr-operation-locks/43",
      ),
    ).toBe("");
  });

  it.each(["list", "gc"])("preserves the complete path producer's failure for %s", (action) => {
    const f = preparedFixture();
    const wrapper = join(f.root, "bin", "node");
    const helper = resolve("scripts/pr-lib/worktree-placement.mjs");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = ${shellQuote(helper)} ] && [ "$2" = list ]; then
  printf '%s\\n' ${shellQuote(JSON.stringify([f.legacy]))}
  exit 23
fi
exec ${shellQuote(join(f.isolation.bin, "node"))} "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    f.env.PATH = `${dirname(wrapper)}${delimiter}${f.env.PATH}`;
    const result = f.run(action);
    expect(result.status, result.stdout + result.stderr).toBe(23);
    expect(f.git(f.legacy, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
  });
});
