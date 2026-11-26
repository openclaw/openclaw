import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCapturedHashProbe } from "./pr-correction-preparation.test-support.js";

const cases = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const script = resolve("scripts/pr-lib/baseline-refresh.mjs");
const lifetime = resolve("scripts/pr-lib/dependency-lifetime-inherit.cjs");
const archive = ".local/prep-evidence.hashes";
const samples = [
  Buffer.alloc(0),
  Buffer.from([0, 255, 254, 10]),
  Buffer.from("blob 17\0not a header\r\n"),
  Buffer.from("café 修正\r\n"),
  Buffer.from([0, 255, 254, 10]),
];

function fixture(count = 6, format = "sha1") {
  const root = cases.make("openclaw-pr-hash-seal-");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], input?: Buffer) =>
    execFileSync("git", args, { cwd: root, env, input, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "pr-42-prep", `--object-format=${format}`]);
  git(["config", "commit.gpgSign", "false"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  writeFileSync(join(root, ".gitattributes"), "* text eol=lf filter=fixture\n");
  git(["config", "filter.fixture.clean", "printf transformed"]);
  git(["add", ".gitignore", ".gitattributes"]);
  git(["commit", "-qm", "test: isolated request sealing"]);
  const head = git(["rev-parse", "HEAD"]);
  const lock = "refs/openclaw/pr-operation-locks/42";
  git(["update-ref", lock, head]);
  mkdirSync(join(root, archive), { recursive: true });
  const blob = (bytes: Buffer) => git(["hash-object", "--no-filters", "--stdin"], bytes);
  const evidence: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const name = String(index).padStart(3, "0");
    const bytes = samples[index % samples.length]!;
    writeFileSync(join(root, archive, name), bytes);
    evidence[name] = blob(bytes);
  }
  const review = Buffer.from("captured review\n");
  writeFileSync(join(root, ".local/correction-review.json"), review);
  // Exercise the internal sealing boundary with real Git state. Full producer,
  // signature and replay admission remain covered by the baseline signing tests.
  const binding = {
    sourceHead: head,
    authority: { ".local/correction-review.json": blob(review) },
  };
  const request = {
    binding: Buffer.from(JSON.stringify(binding)).toString("base64"),
    cwd: realpathSync(root),
    gitDir: git(["rev-parse", "--absolute-git-dir"]),
    evidence: { [archive]: evidence },
  };
  const bytes = Buffer.from(JSON.stringify(request));
  const probe = createCapturedHashProbe(root);
  const guard = join(root, ".local/descriptor-guard.cjs");
  writeFileSync(
    guard,
    `const fs = require("node:fs"), assert = require("node:assert/strict");
const held = process.env.CHECK_HASH_LIFETIME ? [7, 8, 9, 10] : [];
const before = held.map(fd => fs.fstatSync(fd).ino);
process.on("exit", () => {
  assert.deepEqual(held.map(fd => fs.fstatSync(fd).ino), before);
});
if (process.env.SIGNAL_HASH) {
  const cp = require("node:child_process"), run = cp.execFileSync;
  cp.execFileSync = function(file, args, ...rest) {
    try { return run.call(this, file, args, ...rest); }
    catch (error) {
      if (file === process.env.OPENCLAW_PR_GIT && args[0] === "hash-object" &&
          error.signal === "SIGTERM") process.stderr.write("fixture Git SIGTERM observed\\n");
      throw error;
    }
  };
  require("node:module").syncBuiltinESMExports();
}
`,
  );
  const argv = ["--require", guard, script, "save-signing-request", "42", root, lock, head];
  const run = (extra: NodeJS.ProcessEnv = {}, held = false) => {
    const options = {
      cwd: root,
      env: { ...env, ...probe.env, ...extra },
      input: bytes,
      encoding: "utf8" as const,
    };
    if (!held) {
      return spawnSync(requireNodeTool("node"), argv, options);
    }
    for (const fd of [7, 8, 9, 10]) {
      writeFileSync(join(root, `.local/held-${fd}`), `held ${fd}`, { mode: 0o600 });
    }
    return spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec 7<.local/held-7 8<.local/held-8 9<.local/held-9 10<.local/held-10; exec "$@"',
        "hash-held-descriptors",
        requireNodeTool("node"),
        "--require",
        lifetime,
        ...argv,
      ],
      {
        ...options,
        env: {
          ...options.env,
          OPENCLAW_PR_LIFETIME_FILE: join(root, ".local/held-7"),
          OPENCLAW_PR_LIFETIME_ANCESTORS: JSON.stringify([
            { path: join(root, ".local/held-10"), fd: 10 },
          ]),
          CHECK_HASH_LIFETIME: "1",
          HASH_HELD_7: join(root, ".local/held-7"),
          HASH_HELD_10: join(root, ".local/held-10"),
        },
      },
    );
  };
  const saved = () =>
    readdirSync(join(root, ".local")).filter((name) =>
      name.startsWith("prepare-baseline-signing."),
    );
  const expectCleanScratch = () => expect(readdirSync(probe.scratch)).toEqual([]);
  return { root, git, blob, head, bytes, probe, run, saved, expectCleanScratch };
}

describePosix("captured baseline proof hashes", () => {
  it.each([0, 1, 11])("seals %i retained blobs with native captured byte identities", (count) => {
    const f = fixture(count);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const oid = f.blob(f.bytes);
    expect(result.stdout).toBe(oid);
    expect(readFileSync(join(f.root, `.local/prepare-baseline-signing.${oid}.json`))).toEqual(
      f.bytes,
    );
    expect(f.git(["rev-parse", "HEAD"])).toBe(f.head);
    expect(f.git(["status", "--porcelain"])).toBe("");
    f.expectCleanScratch();
  });

  it("preserves Git SHA-256 identities without broadening the SHA-1 admission contract", () => {
    const f = fixture(6, "sha256");
    const result = f.run();
    // Matching 64-character inventory hashes reach the later, unchanged
    // operation-owner guard; SHA-256 PR bindings are still not admitted.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing baseline transition operation owner.");
    expect(result.stderr).not.toContain("Retained proof changed");
    expect(f.saved()).toEqual([]);
    f.expectCleanScratch();
  });

  it("coexists with lifetime leases without forwarding creator or review authority to Git", () => {
    const f = fixture();
    const result = f.run({}, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(f.blob(f.bytes));
    f.expectCleanScratch();
  });

  it.each(["missing", "extra", "invalid"])("refuses %s Git hash output before sealing", (mode) => {
    const f = fixture();
    const result = f.run({ HASH_PROBE_OUTPUT: mode });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Retained proof changed before sealing the signing request.");
    expect(f.saved()).toEqual([]);
    f.expectCleanScratch();
  });

  it.each(["FAIL_HASH", "SIGNAL_HASH"])(
    "fails closed after the Git child fails through %s",
    (fault) => {
      const f = fixture();
      const result = f.run({ [fault]: "1" });
      expect(result.status).toBe(1);
      expect(readFileSync(f.probe.calls, "utf8").trim().split("\n")).toEqual(["0"]);
      expect(result.stderr).toContain(
        fault === "FAIL_HASH" ? "fixture Git hash failure" : "fixture Git hash intentional SIGTERM",
      );
      if (fault === "SIGNAL_HASH") {
        expect(result.stderr).toContain("fixture Git SIGTERM observed");
      }
      expect(f.saved()).toEqual([]);
      expect(f.git(["rev-parse", "HEAD"])).toBe(f.head);
      f.expectCleanScratch();
    },
  );

  it("rechecks live authority after hashing the retained bytes", () => {
    const f = fixture();
    const result = f.run({ MUTATE_ORIGINAL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Correction review authority changed during admission.");
    expect(f.saved()).toEqual([]);
    f.expectCleanScratch();
  });

  it("refuses changed retained bytes on a later seal without replacing the first request", () => {
    const f = fixture();
    const initial = f.run();
    expect(initial.status, initial.stderr).toBe(0);
    const saved = join(f.root, ".local", f.saved()[0]!);
    const before = readFileSync(saved);
    writeFileSync(join(f.root, archive, "001"), "changed retained proof");
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Retained proof changed before sealing the signing request.");
    expect(readFileSync(saved)).toEqual(before);
    f.expectCleanScratch();
  });

  it("refuses a symlink in the retained inventory without hashing its target", () => {
    const f = fixture();
    const member = join(f.root, archive, "000");
    unlinkSync(member);
    symlinkSync("../../.git/config", member);
    const before = readFileSync(join(f.root, ".git/config"));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELOOP|symbolic links/);
    expect(existsSync(f.probe.calls)).toBe(false);
    expect(readFileSync(join(f.root, ".git/config"))).toEqual(before);
    expect(f.saved()).toEqual([]);
    f.expectCleanScratch();
  });
});
