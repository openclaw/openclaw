import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareCrabboxSourceCapsule,
  type CrabboxSourceCapsule,
} from "../../scripts/crabbox-source-capsule.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Git owns this fixture's eligibility. The existing wrapper integration suite
// separately exercises Crabbox's privacy policy and receiver boundary.
const selectSource = String.raw`
const {execFileSync}=require("node:child_process");
const files=[...new Set(execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"}).split("\0").filter(Boolean))];
process.stdout.write(JSON.stringify({candidate:{files:files.length},topFiles:files.map(path=>({path}))}));
`;

function fixture(extraFiles: Record<string, string> = {}) {
  const root = temporary.make("openclaw-capsule-mirror-");
  const repository = join(root, "repository");
  const home = join(root, "home");
  const syncRoot = join(root, "staging");
  mkdirSync(repository);
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, "state"),
    GIT_CONFIG_GLOBAL: join(home, "empty-global"),
    GIT_CONFIG_SYSTEM: join(home, "empty-system"),
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(repository, "init", "--quiet", "--initial-branch=main", "--template=");
  git(repository, "remote", "add", "origin", "https://example.invalid/fixture.git");
  git(repository, "config", "core.fileMode", "true");
  for (const [path, content] of Object.entries({
    ".gitignore": "*.secret\n*.ignored\n",
    "stable.txt": "untouched bytes\n",
    "change.txt": "original bytes\n",
    "deleted.txt": "deleted bytes\n",
    ...extraFiles,
  })) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  git(repository, "add", "-A");
  git(repository, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_DATE",
  ]) {
    vi.stubEnv(key, env[key]);
  }
  vi.stubEnv("CRABBOX_CONFIG", undefined);
  const prepare = (reuseMirror = true, afterSelection = "", repoRoot = repository) =>
    prepareCrabboxSourceCapsule({
      repoRoot,
      syncRoot,
      base: "HEAD",
      reuseMirror,
      syncPlan: { command: process.execPath, args: ["-e", selectSource + afterSelection] },
    });
  const paths = (capsule: CrabboxSourceCapsule) =>
    git(capsule.directory, "ls-tree", "-r", "--name-only", capsule.tree).split("\n");
  const expectColdEquivalent = (warm: CrabboxSourceCapsule) => {
    const cold = prepare(false);
    try {
      expect({ tree: warm.tree, carrier: warm.carrier, digest: warm.digest }).toEqual({
        tree: cold.tree,
        carrier: cold.carrier,
        digest: cold.digest,
      });
      expect(readFileSync(warm.bundlePath)).toEqual(readFileSync(cold.bundlePath));
    } finally {
      cold.cleanup();
    }
  };
  return { root, repository, home, env, syncRoot, git, prepare, paths, expectColdEquivalent };
}

function fileIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs, size: stat.size };
}

describe.skipIf(process.platform === "win32")("persistent Crabbox source capsules", () => {
  it("keeps unchanged files and a warm index while updating eligibility and raw source bytes", () => {
    const f = fixture();
    writeFileSync(join(f.repository, "future.txt"), "initial untracked bytes\n");
    writeFileSync(join(f.repository, "staged.ignored"), "staged ignored bytes\r\n");
    writeFileSync(join(f.repository, "credentials.secret"), "synthetic secret\n");
    f.git(f.repository, "add", "--force", "staged.ignored");
    const first = f.prepare();
    const directory = first.directory;
    const initialPaths = f.paths(first);
    const before = new Map(initialPaths.map((path) => [path, fileIdentity(join(directory, path))]));
    expect(initialPaths).toContain("staged.ignored");
    expect(existsSync(join(directory, "credentials.secret"))).toBe(false);
    first.cleanup();

    const arrivingSecret = join(f.repository, "arriving.secret");
    const unchanged = f.prepare(
      true,
      `require("node:fs").writeFileSync(${JSON.stringify(arrivingSecret)},"synthetic secret");`,
    );
    try {
      expect(unchanged.directory).toBe(directory);
      for (const [path, identity] of before) {
        expect(fileIdentity(join(directory, path)), path).toEqual(identity);
      }
      expect(existsSync(arrivingSecret)).toBe(true);
      expect(existsSync(join(directory, "arriving.secret"))).toBe(false);
      expect(f.git(directory, "diff", "--name-only", "-z")).toBe("");
      expect(f.git(directory, "ls-files", "--debug", "stable.txt")).toMatch(/size: [1-9]\d*/u);
    } finally {
      unchanged.cleanup();
    }

    writeFileSync(join(f.repository, "change.txt"), "updated raw bytes\r\n");
    writeFileSync(join(f.repository, ".gitignore"), "*.secret\n*.ignored\nfuture.txt\n");
    writeFileSync(join(f.repository, "new.txt"), "new untracked bytes\n");
    rmSync(join(f.repository, "deleted.txt"));
    const warm = f.prepare();
    try {
      expect(warm.directory).toBe(directory);
      for (const path of ["stable.txt", "staged.ignored"]) {
        expect(fileIdentity(join(directory, path)), path).toEqual(before.get(path));
      }
      for (const path of [".gitignore", "change.txt"]) {
        expect(fileIdentity(join(directory, path)), path).not.toEqual(before.get(path));
      }
      expect(readFileSync(join(directory, "change.txt"), "utf8")).toBe("updated raw bytes\r\n");
      expect(f.paths(warm)).toEqual([
        ".gitignore",
        "change.txt",
        "new.txt",
        "stable.txt",
        "staged.ignored",
      ]);
      for (const path of ["credentials.secret", "deleted.txt", "future.txt"]) {
        expect(existsSync(join(directory, path)), path).toBe(false);
      }
      f.expectColdEquivalent(warm);
    } finally {
      warm.cleanup();
    }
  });

  it("retains original tracking when an ignored staged source is deleted and later restored", () => {
    const f = fixture();
    const path = "staged.ignored";
    const source = join(f.repository, path);
    writeFileSync(source, "initial ignored source\n");
    f.git(f.repository, "add", "--force", path);
    const first = f.prepare();
    first.cleanup();
    rmSync(source);
    const deleted = f.prepare();
    try {
      expect(deleted.directory).toBe(first.directory);
      expect(f.paths(deleted)).not.toContain(path);
    } finally {
      deleted.cleanup();
    }
    writeFileSync(source, "restored ignored source\r\n");
    const restored = f.prepare();
    try {
      expect(restored.directory).toBe(first.directory);
      expect(f.paths(restored)).toContain(path);
      expect(readFileSync(join(restored.directory, path), "utf8")).toBe(
        "restored ignored source\r\n",
      );
      f.expectColdEquivalent(restored);
    } finally {
      restored.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves symlink bytes, executable mode, and missing sparse entries across reuse",
    () => {
      const f = fixture({ "sparse.txt": "sparse source bytes\n" });
      symlinkSync("stable.txt", join(f.repository, "link"));
      f.git(f.repository, "add", "link");
      const first = f.prepare();
      first.cleanup();
      rmSync(join(f.repository, "link"));
      symlinkSync("change.txt", join(f.repository, "link"));
      chmodSync(join(f.repository, "change.txt"), 0o755);
      f.git(f.repository, "update-index", "--skip-worktree", "sparse.txt");
      rmSync(join(f.repository, "sparse.txt"));
      const warm = f.prepare();
      try {
        expect(warm.directory).toBe(first.directory);
        expect(readlinkSync(join(warm.directory, "link"))).toBe("change.txt");
        expect(lstatSync(join(warm.directory, "change.txt")).mode & 0o111).toBe(0o111);
        expect(readFileSync(join(warm.directory, "sparse.txt"), "utf8")).toBe(
          "sparse source bytes\n",
        );
        expect(f.git(warm.directory, "ls-tree", warm.tree, "link")).toMatch(/^120000 blob /u);
        expect(f.git(warm.directory, "ls-tree", warm.tree, "change.txt")).toMatch(/^100755 blob /u);
        f.expectColdEquivalent(warm);
      } finally {
        warm.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["file", "symlink"])(
    "replaces a deleted source directory with a %s on the next warm run",
    (kind) => {
      const f = fixture({ "ancestor/file.txt": "nested source\n" });
      const first = f.prepare();
      first.cleanup();
      const ancestor = join(f.repository, "ancestor");
      rmSync(ancestor, { recursive: true });
      const deleted = f.prepare();
      try {
        expect(deleted.directory).toBe(first.directory);
        expect(f.paths(deleted)).not.toContain("ancestor/file.txt");
      } finally {
        deleted.cleanup();
      }
      if (kind === "file") {
        writeFileSync(ancestor, "replacement source\n");
      } else {
        symlinkSync("stable.txt", ancestor);
      }
      const replacement = f.prepare();
      try {
        expect(replacement.directory).toBe(first.directory);
        const mirrored = join(replacement.directory, "ancestor");
        if (kind === "file") {
          expect(readFileSync(mirrored, "utf8")).toBe("replacement source\n");
          expect(lstatSync(mirrored).isFile()).toBe(true);
        } else {
          expect(readlinkSync(mirrored)).toBe("stable.txt");
        }
        const paths = f.paths(replacement);
        expect(paths).toContain("ancestor");
        expect(paths).not.toContain("ancestor/file.txt");
        f.expectColdEquivalent(replacement);
      } finally {
        replacement.cleanup();
      }
    },
  );

  it.each([
    "missing file",
    "corrupt file",
    "corrupt metadata",
    "missing metadata",
    "hardlink metadata",
    "missing index",
    "hardlink index",
    ...(process.platform === "win32" ? [] : ["symlink index"]),
    "witness mismatch",
  ])("rebuilds an unusable mirror before returning any source: %s", (damage) => {
    const f = fixture();
    const first = f.prepare();
    first.cleanup();
    const victim = join(f.root, "unrelated-file");
    let victimBytes: string | Buffer = "unrelated victim bytes\n";
    if (damage === "missing file") {
      rmSync(join(first.directory, "stable.txt"));
    } else if (damage === "corrupt file") {
      writeFileSync(join(first.directory, "stable.txt"), "corrupted cached bytes\n");
    } else if (damage === "missing index") {
      rmSync(join(first.directory, ".git", "mirror-candidate-index"));
    } else if (damage === "symlink index" || damage === "hardlink index") {
      writeFileSync(victim, victimBytes);
      const index = join(first.directory, ".git", "index");
      rmSync(index);
      if (damage === "symlink index") {
        symlinkSync(victim, index);
      } else {
        linkSync(victim, index);
      }
    } else if (damage === "witness mismatch") {
      const receiptPath = join(first.staging.root, "staging.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        witness: { commit: string };
      };
      receipt.witness.commit = "0".repeat(40);
      writeFileSync(receiptPath, JSON.stringify(receipt));
    } else if (damage === "hardlink metadata") {
      const metadata = join(first.staging.root, "mirror.sqlite");
      // Preserve the sealed database bytes so only the shared-inode guard can
      // prevent SQLite from opening and updating the independent victim.
      victimBytes = readFileSync(metadata);
      writeFileSync(victim, victimBytes);
      rmSync(metadata);
      linkSync(victim, metadata);
    } else {
      const metadata = join(first.staging.root, "mirror.sqlite");
      if (damage === "missing metadata") {
        rmSync(metadata);
      } else {
        writeFileSync(metadata, "not a SQLite database\n");
      }
    }
    const rebuilt = f.prepare();
    try {
      expect(rebuilt.directory).not.toBe(first.directory);
      expect(readFileSync(join(rebuilt.directory, "stable.txt"), "utf8")).toBe("untouched bytes\n");
      expect(rebuilt.tree).toBe(first.tree);
      if (["symlink index", "hardlink index", "hardlink metadata"].includes(damage)) {
        expect(readFileSync(victim)).toEqual(Buffer.from(victimBytes));
      }
    } finally {
      rebuilt.cleanup();
    }
  });

  it("keeps an outstanding capsule immutable and visibly falls back through a worktree alias", () => {
    const f = fixture();
    const alias = join(f.root, "alias");
    symlinkSync(f.repository, alias, process.platform === "win32" ? "junction" : "dir");
    const first = f.prepare();
    let second: CrabboxSourceCapsule | undefined;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(f.repository, "change.txt"), "concurrent newer source\n");
      second = f.prepare(true, "", alias);
      expect(second.directory).not.toBe(first.directory);
      expect(readFileSync(join(first.directory, "change.txt"), "utf8")).toBe("original bytes\n");
      expect(readFileSync(join(second.directory, "change.txt"), "utf8")).toBe(
        "concurrent newer source\n",
      );
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toMatch(
        /mirror.*(?:busy|in use|locked).*(?:cold|fresh) capsule/is,
      );
    } finally {
      second?.cleanup();
      first.cleanup();
    }
    const next = f.prepare();
    try {
      expect(next.directory).toBe(first.directory);
      expect(readFileSync(join(next.directory, "change.txt"), "utf8")).toBe(
        "concurrent newer source\n",
      );
    } finally {
      next.cleanup();
    }
  });

  it.each(["stable.txt", "new.txt", "frozen mirror"])(
    "rejects source or frozen bytes changed during warm freezing: %s",
    (path) => {
      const f = fixture();
      const first = f.prepare();
      first.cleanup();
      const source = path === "frozen mirror" ? "stable.txt" : join(f.repository, path);
      expect(() =>
        f.prepare(
          true,
          `require("node:fs").writeFileSync(${JSON.stringify(source)},"raced edit\\n");`,
        ),
      ).toThrow(/changed while freezing/u);
      const next = f.prepare();
      try {
        expect(
          readFileSync(
            join(next.directory, path === "frozen mirror" ? "stable.txt" : path),
            "utf8",
          ),
        ).toBe(path === "frozen mirror" ? "untouched bytes\n" : "raced edit\n");
        f.expectColdEquivalent(next);
      } finally {
        next.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "suppresses configured Git callbacks while preserving a reusable mirror",
    () => {
      const f = fixture();
      const hooks = join(f.root, "hooks");
      mkdirSync(hooks);
      const hookMarker = join(f.root, "hook-marker");
      const globalMarker = join(f.root, "global-fsmonitor-marker");
      const sourceMarker = join(f.root, "source-fsmonitor-marker");
      const writeCallback = (path: string, marker: string, output = "") => {
        const quoted = `'${marker.replaceAll("'", "'\\''")}'`;
        writeFileSync(path, `#!/bin/sh\nprintf callback >> ${quoted}\n${output}`, { mode: 0o755 });
      };
      writeCallback(join(hooks, "reference-transaction"), hookMarker);
      const globalMonitor = join(f.root, "global-fsmonitor");
      const sourceMonitor = join(f.root, "source-fsmonitor");
      const monitorOutput = "printf 'token\\000/\\000'\n";
      writeCallback(globalMonitor, globalMarker, monitorOutput);
      writeCallback(sourceMonitor, sourceMarker, monitorOutput);
      const globalConfig = join(f.home, ".gitconfig");
      f.env.GIT_CONFIG_GLOBAL = globalConfig;
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      f.git(f.repository, "config", "--global", "core.hooksPath", hooks);
      f.git(f.repository, "config", "--global", "core.fsmonitor", globalMonitor);
      f.git(f.repository, "config", "core.fsmonitor", sourceMonitor);

      const first = f.prepare();
      first.cleanup();
      const warm = f.prepare();
      try {
        expect(warm.directory).toBe(first.directory);
        expect(warm.tree).toBe(first.tree);
        for (const marker of [hookMarker, globalMarker, sourceMarker]) {
          expect(existsSync(marker), marker).toBe(false);
        }
      } finally {
        warm.cleanup();
      }
      // These controls prove Git dispatches each fixture callback when its
      // ordinary configuration is used outside the mirror's protected boundary.
      f.git(f.repository, "update-ref", "refs/heads/hook-control", "HEAD");
      f.git(f.repository, "status", "--porcelain");
      f.git(f.repository, "-c", `core.fsmonitor=${globalMonitor}`, "status", "--porcelain");
      for (const marker of [hookMarker, globalMarker, sourceMarker]) {
        expect(readFileSync(marker, "utf8"), marker).toContain("callback");
      }
    },
  );
});
