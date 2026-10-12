import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCorrectionFixture } from "./pr-correction-preparation.test-support.js";

const cases = useAutoCleanupTempDirTracker(afterEach);
const keys = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;
let key: string;
let signers: string;

function fixture(
  conflict: false | "delete" | "content" | "add" | "attributes" | "clean" | "binary" = false,
  headRefName = "topic",
) {
  let baseContent =
    "import { format } from './format';\nexport const alias = format;\n\nfunction cache(value) {\n  return Number(value);\n}\n\nexport const show = (value) => alias(cache(value));\n";
  let sourceContent =
    "import { format, cache } from './format';\nexport const alias = format;\n\nexport const show = (value) => alias(cache(value));\n";
  let baselineContent =
    "import { format, finite } from './format';\n\nfunction cache(value) {\n  return finite(value);\n}\n\nexport const show = (value) => format(cache(value));\n";
  if (conflict === "clean") {
    baseContent = "first\r\n2\r\n3\r\n4\r\n5\r\nlast\r\n";
    sourceContent = "source café\r\n2\r\n3\r\n4\r\n5\r\nlast\r\n";
    baselineContent = "first\r\n2\r\n3\r\n4\r\n5\r\nbaseline 修正\r\n";
  } else if (conflict === "binary") {
    baseContent = "base\0blob\n";
    sourceContent = "source\0blob\n";
    baselineContent = "baseline\0blob\n";
  } else if (conflict !== "content" && conflict !== "attributes") {
    baseContent = "broken\n";
    sourceContent = "corrected\n";
    baselineContent = "upstream edit\n";
  }
  const f = createCorrectionFixture(cases.make("openclaw-pr-baseline-"), baseContent);
  f.git("config", "gpg.format", "ssh");
  f.git("config", "user.signingKey", key);
  f.git("config", "gpg.ssh.allowedSignersFile", signers);
  f.git("config", "commit.gpgSign", "true");
  const metaPath = join(f.root, ".local/pr-meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.state = "OPEN";
  meta.baseRefName = "main";
  meta.headRefName = headRefName;
  writeFileSync(metaPath, JSON.stringify(meta));
  const metaEnv = join(f.root, ".local/pr-meta.env");
  writeFileSync(
    metaEnv,
    readFileSync(metaEnv, "utf8").replace("PR_HEAD=topic", `PR_HEAD=${headRefName}`),
  );
  expect(f.run("prepare_init 42 '' correction").status).toBe(0);
  f.git("branch", "baseline", f.incoming);
  f.commitFix(sourceContent);
  writeFileSync(join(f.root, "fixup.txt"), "complete correction scope\n");
  f.git("add", "fixup.txt");
  if (conflict === "delete") {
    f.git("rm", "docs/fix.md");
  }
  f.git("commit", "-S", "-qm", "fix: preserve the complete correction");
  const source = f.git("rev-parse", "HEAD");
  expect(f.run("prepare_correction_review_init 42").status).toBe(0);
  f.approve();
  const review = readFileSync(join(f.root, ".local/correction-review.json"));
  const incomingReview = readFileSync(join(f.root, ".local/review.json"));
  writeFileSync(join(f.root, ".local/gates-build.log"), "prior completed build\n");
  writeFileSync(
    join(f.root, ".local/gates.env"),
    `GATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${source}\n`,
  );
  f.git("checkout", "-q", "baseline");
  writeFileSync(join(f.root, "upstream.txt"), "unrelated upstream repair\n");
  if (conflict && conflict !== "add") {
    writeFileSync(join(f.root, "docs/fix.md"), baselineContent);
  }
  if (conflict === "add") {
    writeFileSync(join(f.root, "fixup.txt"), "upstream addition\n");
  }
  if (conflict === "attributes") {
    writeFileSync(join(f.root, ".gitattributes"), "docs/fix.md merge=union\n");
  }
  if (conflict === "clean") {
    chmodSync(join(f.root, "docs/fix.md"), 0o755);
  }
  f.git("add", ".");
  f.git("commit", "-qm", "fix: upstream baseline");
  const baseline = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "pr-42-prep");
  const run = (command: string, setup = "", env: NodeJS.ProcessEnv = {}) =>
    f.run(
      [
        'source "$script_parent_dir/pr-lib/worktree.sh"',
        'source "$script_parent_dir/pr-lib/operation-lock.sh"',
        'source "$script_parent_dir/pr-lib/push.sh"',
        "enter_worktree() { :; }",
        "repo_root() { pwd; }",
        "mark_pr_operation_side_effects_started() { :; }",
        `PR_MAIN_SHA=${baseline}`,
        "PR_OPERATION_LOCK_REF=refs/openclaw/pr-operation-locks/42",
        `PR_OPERATION_LOCK_OWNER_OID=${f.incoming}`,
        'git update-ref "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"',
        setup,
        command,
      ].join("\n"),
      env,
    );
  const refresh = (extra = "", setup = "", env: NodeJS.ProcessEnv = {}) =>
    run(
      `prepare_baseline_refresh 42 --expected-head ${source} --baseline ${baseline} ${extra}`,
      setup,
      env,
    );
  const manifest = (bytes: string | null, path = "docs/fix.md") => {
    const blob = (commit: string) => {
      const line = f.git("ls-tree", commit, "--", path);
      if (!line) {
        return null;
      }
      const [mode, , oid] = line.split(/\s/u);
      if (!mode || !oid) {
        throw new Error("Invalid fixture tree entry");
      }
      return { mode, oid };
    };
    if (bytes !== null) {
      writeFileSync(join(f.root, ".local/resolved.txt"), bytes);
    }
    const resolution = {
      path,
      base: blob(f.incoming),
      source: blob(source),
      baseline: blob(baseline),
      resolved:
        bytes === null
          ? null
          : {
              mode: "100644",
              file: "resolved.txt",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
    };
    const value = {
      version: 1,
      pr: 42,
      sourceHead: source,
      baselineHead: baseline,
      forkBase: f.incoming,
      resolutions: [resolution],
    };
    const save = () =>
      writeFileSync(join(f.root, ".local/resolutions.json"), JSON.stringify(value));
    save();
    return { value, resolution, save, args: "--resolutions .local/resolutions.json" };
  };
  return { ...f, run, refresh, manifest, source, baseline, review, incomingReview };
}

describePosix("native correction baseline refresh", () => {
  beforeAll(() => {
    const root = keys.make("openclaw-pr-baseline-key-");
    key = join(root, "key");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    expect(generated.status).toBe(0);
    signers = join(root, "allowed-signers");
    writeFileSync(signers, `fixture@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`);
  });

  it("replays the complete correction onto a baseline and retires old proof before fresh review", () => {
    const f = fixture(false, "topic/PREP_BASELINE_REFRESH_OID");
    const result = f.refresh();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const head = f.git("rev-parse", "HEAD");
    expect(f.git("show", "HEAD:docs/fix.md")).toBe("corrected");
    expect(f.git("show", "HEAD:fixup.txt")).toBe("complete correction scope");
    expect(f.git("show", "HEAD:upstream.txt")).toBe("unrelated upstream repair");
    expect(f.git("show", "-s", "--format=%P", head)).toBe(`${f.source} ${f.baseline}`);
    f.git("verify-commit", head);
    expect(readFileSync(join(f.root, ".local/review.json"))).toEqual(f.incomingReview);
    const archive = readdirSync(join(f.root, ".local")).find((name) =>
      name.startsWith("prep-evidence."),
    );
    if (!archive) {
      throw new Error("Missing retained preparation evidence");
    }
    expect(readFileSync(join(f.root, ".local", archive, "correction-review.json"))).toEqual(
      f.review,
    );
    expect(readFileSync(join(f.root, ".local", archive, "gates-build.log"), "utf8")).toBe(
      "prior completed build\n",
    );
    expect(existsSync(join(f.root, ".local/gates.env"))).toBe(false);
    expect(f.run("require_prepared_review 42").status).not.toBe(0);
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    expect(f.run("require_prepared_review 42").status).toBe(0);
  });

  it.each(["delete", "binary"] as const)(
    "requires exact native conflict identities for %s/edit and preserves the reviewed resolution",
    (shape) => {
      const f = fixture(shape);
      const refused = f.refresh();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("Expected exactly the computed conflict resolutions");
      expect(f.git("rev-parse", "HEAD")).toBe(f.source);
      expect(readFileSync(join(f.root, ".local/correction-review.json"))).toEqual(f.review);
      const content = shape === "delete" ? "" : "resolved\0binary\n";
      const manifest = f.manifest(content);
      const result = f.refresh(manifest.args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(f.root, "docs/fix.md"), "utf8")).toBe(content);
      const binding = JSON.parse(
        readFileSync(join(f.root, ".local/prepare-baseline.json"), "utf8"),
      );
      expect(binding.resolutions[0].resolved.oid).toBe(f.git("rev-parse", "HEAD:docs/fix.md"));
      expect(binding.resolutions[0].resolved.file).toBeUndefined();
      expect(f.git("show", "HEAD:upstream.txt")).toBe("unrelated upstream repair");
    },
  );

  it("combines independent text edits as exact bytes with the baseline executable mode", () => {
    const f = fixture("clean");
    const result = f.refresh();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "docs/fix.md"))).toEqual(
      Buffer.from("source café\r\n2\r\n3\r\n4\r\n5\r\nbaseline 修正\r\n"),
    );
    expect(f.git("ls-tree", "HEAD", "--", "docs/fix.md")).toMatch(/^100755 blob /u);
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
  });

  it("resolves a native differing add/add without consulting the source worktree", () => {
    const f = fixture("add");
    const manifest = f.manifest("complete correction scope and upstream addition\n", "fixup.txt");
    expect(manifest.resolution.base).toBeNull();
    const result = f.refresh(manifest.args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git("show", "HEAD:fixup.txt")).toBe("complete correction scope and upstream addition");
    expect(f.git("show", "HEAD:upstream.txt")).toBe("unrelated upstream repair");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
  });

  it("reconstructs historical content independently of committed and local merge attributes", () => {
    const f = fixture("attributes");
    const content =
      "import { format, cache } from './format';\nexport const show = (value) => format(cache(value));\n";
    const manifest = f.manifest(content);
    const result = f.refresh(manifest.args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "docs/fix.md"), "utf8")).toBe(content);
    writeFileSync(join(f.root, ".gitattributes"), "docs/fix.md merge=fixture\n");
    f.git("add", ".gitattributes");
    f.git("commit", "-S", "-qm", "fix: update product attributes");
    const driver = "printf used >> .local/driver-used; exit 0";
    f.git("config", "merge.fixture.driver", driver);
    f.git("config", "merge.conflictStyle", "zdiff3");
    f.git("config", "diff.algorithm", "histogram");
    writeFileSync(join(f.root, ".git/info/attributes"), "docs/fix.md merge=fixture\n");
    const global = join(f.root, ".local/global-config");
    const attributes = join(f.root, ".local/global-attributes");
    writeFileSync(attributes, "docs/fix.md merge=fixture\n");
    f.git("config", "--file", global, "core.attributesFile", attributes);
    f.git("config", "--file", global, "merge.fixture.driver", driver);
    const replay = f.run("prepare_correction_review_init 42", "", { GIT_CONFIG_GLOBAL: global });
    expect(replay.status, replay.stdout + replay.stderr).toBe(0);
    expect(existsSync(join(f.root, ".local/driver-used"))).toBe(false);
    expect(readFileSync(join(f.root, "docs/fix.md"), "utf8")).toBe(content);
  });

  it.each(["stale", "extra", "digest", "symlink"])(
    "refuses %s resolution authority without retiring current review",
    (change) => {
      const f = fixture("delete");
      const manifest = f.manifest("explicit resolution\n");
      if (change === "stale") {
        manifest.resolution.baseline = manifest.resolution.base;
      }
      if (change === "extra") {
        manifest.value.resolutions.push({ ...manifest.resolution, path: "upstream.txt" });
      }
      if (change === "digest") {
        appendFileSync(join(f.root, ".local/resolved.txt"), "changed");
      }
      if (change === "symlink") {
        rmSync(join(f.root, ".local/resolved.txt"));
        symlinkSync("../upstream.txt", join(f.root, ".local/resolved.txt"));
      }
      manifest.save();
      const result = f.refresh(manifest.args);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.source);
      expect(readFileSync(join(f.root, ".local/correction-review.json"))).toEqual(f.review);
      expect(existsSync(join(f.root, ".local/gates.env"))).toBe(true);
    },
  );

  it("includes later fixups outside the original scope and refuses changed binding bytes", () => {
    const f = fixture();
    expect(f.refresh().status).toBe(0);
    mkdirSync(join(f.root, "src"));
    writeFileSync(join(f.root, "src/runtime.ts"), "export const fixed = true;\n");
    f.git("add", "src/runtime.ts");
    f.git("commit", "-S", "-qm", "fix: complete the runtime correction");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const invalid = f.run("require_prepared_review 42");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("runtime file changes require");
    const path = join(f.root, ".local/correction-review.json");
    const review = JSON.parse(readFileSync(path, "utf8"));
    review.behavioralSweep.status = "pass";
    review.behavioralSweep.branches = [
      { path: "src/runtime.ts", decision: "later fixup", outcome: "reviewed" },
    ];
    writeFileSync(path, JSON.stringify(review));
    expect(f.run("require_prepared_review 42").status).toBe(0);
    appendFileSync(join(f.root, ".local/prepare-baseline.json"), "\n");
    expect(f.run("require_prepared_review 42").status).not.toBe(0);
  });

  it.each(["binding", "restore", "CAS"])(
    "retains and replays the same owned transition after %s failure",
    (phase) => {
      const f = fixture();
      let setup = "";
      const env: NodeJS.ProcessEnv = {};
      if (phase === "binding") {
        const hook = join(f.root, ".local/write-fault.mjs");
        writeFileSync(
          hook,
          `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (to === '.local/prep-context.env') throw new Error('injected context write failure');
  return rename(from, to);
};\n`,
        );
        env.NODE_OPTIONS = `--import=${hook}`;
      } else if (phase === "restore") {
        setup = `pr_git() {
        if [ "$1" = --literal-pathspecs ] && [ "$2" = restore ]; then
          command git restore --source="$(jq -r .target .local/review-transition.json)" --staged --worktree -- docs/fix.md
          return 91
        fi
        command git "$@"
      }`;
      } else {
        setup = `pr_git() {
        command git "$@" || return $?
        if [ "$1" = update-ref ] && [ "$2" = --no-deref ] && [ "$3" = refs/heads/pr-42-prep ]; then return 91; fi
      }`;
      }
      const interrupted = f.refresh("", setup, env);
      expect(interrupted.status, interrupted.stdout + interrupted.stderr).not.toBe(0);
      const journalPath = join(f.root, ".local/review-transition.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      expect(journal.source).toBe(f.source);
      expect(journal.mode).toBe("prep");
      expect(f.run("require_prepared_review 42").status).not.toBe(0);
      const resumed = f.run("recover_review_transition 42");
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(journal.target);
      expect(f.git("status", "--porcelain")).toBe("");
      expect(existsSync(journalPath)).toBe(false);
      expect(existsSync(join(f.root, ".local/gates.env"))).toBe(false);
      expect(readFileSync(join(f.root, ".local/review.json"))).toEqual(f.incomingReview);
    },
  );

  it("preserves active evidence when an archive copy fails verification", () => {
    const f = fixture();
    const result = f.refresh(
      "",
      `cp() { command cp "$@"; printf '\\ncorrupt' >> "$3/$(basename "$2")"; }`,
    );
    expect(result.status).not.toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(f.source);
    expect(readFileSync(join(f.root, ".local/correction-review.json"))).toEqual(f.review);
    expect(existsSync(join(f.root, ".local/gates.env"))).toBe(true);
    expect(existsSync(join(f.root, ".local/review-transition.json"))).toBe(false);
  });

  it.each(["head", "repository", "review", "lock"])(
    "refuses %s drift after signing without handing off a transition",
    (change) => {
      const f = fixture();
      const setup =
        change === "head" || change === "repository"
          ? `read_pr_view_json() {
          local count=0; [ ! -f .local/reads ] || count=$(cat .local/reads)
          count=$((count + 1)); echo "$count" > .local/reads
          if [ "$count" -gt 1 ]; then
            jq '${change === "head" ? `.headRefOid="${f.baseline}"` : '.headRepository={id:"changed"}'}' .local/pr-meta.json
          else cat .local/pr-meta.json; fi
        }`
          : `node() {
          command node "$@" || return $?
          if [ "\${2:-}" = create ]; then
            ${change === "review" ? "printf '\\n' >> .local/correction-review.json" : `command git update-ref "$PR_OPERATION_LOCK_REF" ${f.baseline}`}
          fi
        }`;
      const result = f.refresh("", setup);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.source);
      expect(existsSync(join(f.root, ".local/review-transition.json"))).toBe(false);
      expect(existsSync(join(f.root, ".local/gates.env"))).toBe(true);
    },
  );

  it("checks the live lock inside installation before writing any preparation authority", () => {
    const f = fixture();
    const context = readFileSync(join(f.root, ".local/prep-context.env"));
    const result = f.refresh(
      "",
      `node() {
      if [ "\${2:-}" = install-transition ]; then
        command git update-ref "$PR_OPERATION_LOCK_REF" ${f.baseline}
      fi
      command node "$@"
    }`,
    );
    expect(result.status).not.toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(f.source);
    expect(readFileSync(join(f.root, ".local/prep-context.env"))).toEqual(context);
    expect(readFileSync(join(f.root, ".local/correction-review.json"))).toEqual(f.review);
    expect(existsSync(join(f.root, ".local/prepare-baseline.json"))).toBe(false);
    expect(existsSync(join(f.root, ".local/gates.env"))).toBe(true);
    expect(existsSync(join(f.root, ".local/review-transition.json"))).toBe(true);
  });

  it("preserves a third-party preparation ref and journal when replay loses its source CAS", () => {
    const f = fixture();
    const stopped = f.refresh(
      "",
      `pr_git() {
      if [ "$1" = read-tree ]; then return 91; fi
      command git "$@"
    }`,
    );
    expect(stopped.status).not.toBe(0);
    const journalPath = join(f.root, ".local/review-transition.json");
    const journal = readFileSync(journalPath);
    const foreign = f.git(
      "commit-tree",
      "-S",
      `${f.source}^{tree}`,
      "-p",
      f.source,
      "-m",
      "foreign preparation",
    );
    f.git("update-ref", "refs/heads/pr-42-prep", foreign, f.source);
    const before = readFileSync(join(f.root, "docs/fix.md"));
    const replay = f.run("recover_review_transition 42");
    expect(replay.status).not.toBe(0);
    expect(f.git("rev-parse", "refs/heads/pr-42-prep")).toBe(foreign);
    expect(readFileSync(join(f.root, "docs/fix.md"))).toEqual(before);
    expect(readFileSync(journalPath)).toEqual(journal);
  });

  it("rejects a signed replacement that drops a fixup from the reconstructed candidate", () => {
    const f = fixture();
    expect(f.refresh().status).toBe(0);
    const original = f.git("rev-parse", "HEAD");
    const message = f.git("show", "-s", "--format=%B", "HEAD");
    const replacement = f.git(
      "commit-tree",
      "-S",
      `${f.baseline}^{tree}`,
      "-p",
      f.source,
      "-p",
      f.baseline,
      "-m",
      message,
    );
    f.git("reset", "--hard", replacement);
    const context = join(f.root, ".local/prep-context.env");
    writeFileSync(context, readFileSync(context, "utf8").replace(original, replacement));
    const result = f.run("prepare_correction_review_init 42");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not reproduce the complete product delta");
  });

  it("does not reinterpret a merge tool failure as an operator-resolvable conflict", () => {
    const f = fixture("content");
    const manifest = f.manifest("resolved\n");
    const shim = join(f.root, ".local/git-failure");
    writeFileSync(
      shim,
      '#!/bin/sh\nif [ "$1" = merge-file ]; then echo "fixture merge failure" >&2; exit 255; fi\nexec "$FIXTURE_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const result = f.refresh(manifest.args, "", {
      OPENCLAW_PR_GIT: shim,
      FIXTURE_REAL_GIT: realGit,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot replay docs/fix.md: fixture merge failure");
    expect(f.git("rev-parse", "HEAD")).toBe(f.source);
    expect(existsSync(join(f.root, ".local/review-transition.json"))).toBe(false);
  });

  it.each([".LOCAL/foreign", "fixup.txt/nested"])(
    "refuses unsafe baseline entry %s before transition",
    (path) => {
      const f = fixture();
      const blob = f.git("rev-parse", `${f.baseline}:upstream.txt`);
      f.git("read-tree", f.baseline);
      f.git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
      const tree = f.git("write-tree");
      f.git("read-tree", "HEAD");
      const baseline = f.git(
        "commit-tree",
        tree,
        "-p",
        f.baseline,
        "-m",
        "unsafe fixture baseline",
      );
      const result = f.run(
        `PR_MAIN_SHA=${baseline}; prepare_baseline_refresh 42 --expected-head ${f.source} --baseline ${baseline}`,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unsupported product path|Directory\/file overlap/u);
      expect(f.git("rev-parse", "HEAD")).toBe(f.source);
      expect(existsSync(join(f.root, ".local/review-transition.json"))).toBe(false);
    },
  );
});
