import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("fresh incoming review after a published correction's baseline refresh", () => {
  let f: ReturnType<typeof createBaselineFixture>;
  let incoming: string;
  let head: string;
  let tree: string;
  let lineage: string;
  let args: string[];
  let original: Record<string, Buffer>;
  const git = (...values: string[]) => f.prepGit(...values);
  const oid = (name: string) => git("hash-object", "--no-filters", f.local(name));
  const read = (name: string) => f.readLocal(name);
  const write = (name: string, value: string | Buffer) => f.writeLocal(name, value);
  const retained = () => {
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(tree);
    expect(git("branch", "--show-current")).toBe("pr-42-prep");
    expect(git("status", "--porcelain")).toBe("");
  };
  const reject = (env: NodeJS.ProcessEnv = {}, selected = args) => {
    const result = f.run("prepare-correction-continue", selected, env);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    retained();
    return result.stdout + result.stderr;
  };

  beforeAll(() => {
    f = createBaselineFixture(dirs.make("openclaw-baseline-continuation-"), 1);
    incoming = f.publish();
    const baseline = f.advanceMain("new main");
    f.pass("prepare-baseline-refresh", f.manifest(baseline));
    head = git("rev-parse", "HEAD");
    tree = git("rev-parse", "HEAD^{tree}");
    lineage = JSON.parse(read("prepare-baseline.json").toString()).archive;
    expect(existsSync(f.local("correction-incoming-review.json"))).toBe(false);
    original = f.snapshot(["pr-meta.json", "pr-meta.env", "review.json"]);
  });

  it("refuses failed metadata retention before replacing either active identity file", () => {
    const cp = join(f.root, "bin/cp");
    writeFileSync(
      cp,
      '#!/bin/sh\ncase "$*" in *review-evidence*) echo "fixture retention failed" >&2; exit 73;; esac\nexec /bin/cp "$@"\n',
      { mode: 0o755 },
    );
    try {
      const result = f.run("review-init");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("fixture retention failed");
      f.expectSnapshot(original);
    } finally {
      unlinkSync(cp);
      git("switch", "-q", "pr-42-prep");
    }
    retained();
  });

  it("retains exact prior identity through the ordinary fresh hosted review flow", () => {
    f.pass("review-init");
    const archives = readdirSync(f.local("")).filter((name) => name.startsWith("review-evidence."));
    expect(
      archives.some((archive) =>
        Object.entries(original).every(([name, bytes]) => {
          const path = f.local(`${archive}/${name}`);
          return existsSync(path) && readFileSync(path).equals(bytes);
        }),
      ),
    ).toBe(true);
    f.pass("review-checkout-pr");
    f.pass("review-artifacts-init");
    const review = validReview(incoming);
    review.recommendation = "NEEDS WORK";
    review.issueValidation.status = "valid";
    review.findings.push({
      id: "I2",
      severity: "IMPORTANT",
      title: "Current main conflicts with the published correction",
      area: f.product[0]!,
      fix: "Resolve the baseline conflict canonically",
    });
    write("review.json", JSON.stringify(review));
    f.pass("review-validate-artifacts");
    git("switch", "-q", "pr-42-prep");
    args = Object.entries({
      "expected-head": head,
      "expected-tree": tree,
      "incoming-head": incoming,
      "incoming-review": oid("review.json"),
      "publication-receipt": "push",
      "publication-oid": oid("prepare-push-result.env"),
    }).flatMap(([name, value]) => [`--${name}`, value]);
    retained();
  });

  it("rejects changed or redirected historical lineage without replacing current authority", () => {
    const active = f.snapshot(["prep-context.env", "prepare-baseline.json", "review.json"]);
    const historical = join(f.worktree, lineage);
    for (const name of [
      "prep-context.env",
      "correction-incoming-review.json",
      "prepare-push-result.env",
    ]) {
      const path = join(historical, name);
      const bytes = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
        expect(reject()).toContain("Retained publication lineage changed");
        f.expectSnapshot(active);
      } finally {
        writeFileSync(path, bytes);
      }
    }
    const elsewhere = `${historical}-elsewhere`;
    renameSync(historical, elsewhere);
    try {
      symlinkSync(elsewhere, historical);
      expect(reject()).toContain("Invalid retained proof directory");
      f.expectSnapshot(active);
    } finally {
      unlinkSync(historical);
      renameSync(elsewhere, historical);
    }
    const binding = read("prepare-baseline.json");
    write(
      "prepare-baseline.json",
      JSON.stringify({
        ...JSON.parse(binding.toString()),
        archive: ".local/prep-evidence.foreign",
      }),
    );
    try {
      expect(reject()).toContain("Retained baseline binding differs");
    } finally {
      write("prepare-baseline.json", binding);
    }
    f.expectSnapshot(active);
  });

  it("rechecks historical lineage after the live read and replays only the same current snapshot", () => {
    const hook = f.local("lineage-io.mjs");
    writeFileSync(
      hook,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/correction-continuation.mjs') && process.argv[2] === 'apply') {
  if (process.env.FIXTURE_EFFECT === 'lineage-drift') {
    fs.appendFileSync(process.env.FIXTURE_LINEAGE + '/prep-context.env', '# changed\\n');
  }
  if (process.env.FIXTURE_EFFECT === 'partial') {
    const remove = fs.unlinkSync;
    fs.unlinkSync = function(path) {
      const result = remove.call(this, path);
      if (path === '.local/prepare-baseline.json') throw new Error('fixture interrupted retirement');
      return result;
    };
    syncBuiltinESMExports();
  }
}
`,
    );
    const extra = { NODE_OPTIONS: `--import=${hook}`, FIXTURE_LINEAGE: join(f.worktree, lineage) };
    const contextPath = join(f.worktree, lineage, "prep-context.env");
    const context = readFileSync(contextPath);
    try {
      expect(reject({ ...extra, FIXTURE_EFFECT: "lineage-drift" })).toContain(
        "Retained publication lineage changed",
      );
      expect(existsSync(f.local("review-transition.json"))).toBe(false);
    } finally {
      writeFileSync(contextPath, context);
    }
    const fresh = f.snapshot(["pr-meta.json", "pr-meta.env", "review.json"]);
    expect(reject({ ...extra, FIXTURE_EFFECT: "partial" })).toContain(
      "fixture interrupted retirement",
    );
    const journal = read("review-transition.json");
    const request = JSON.parse(journal.toString()).continuation;
    expect(request.archive).not.toBe(lineage);
    expect(request.lineage.archive).toBe(lineage);
    expect(existsSync(join(f.worktree, request.archive, "prepare-baseline.json"))).toBe(true);
    expect(existsSync(f.local("prepare-baseline.json"))).toBe(false);
    const changed = args.map((value, i) =>
      args[i - 1] === "--expected-tree" ? "a".repeat(40) : value,
    );
    expect(reject({}, changed)).toContain("Selected continuation differs");
    expect(read("review-transition.json")).toEqual(journal);
    f.pass("prepare-correction-continue", args);
    retained();
    f.expectSnapshot(fresh);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(read("prep-context.env").toString()).toContain(`PR_HEAD_SHA_BEFORE='${incoming}'`);
    expect(read("prep-context.env").toString()).not.toContain("PREP_BASELINE_REFRESH");
    expect(f.run("prepare-push").status).not.toBe(0);
    f.pass("prepare-correction-review-init");
    const candidate = JSON.parse(read("correction-review.json").toString());
    expect(candidate.pr.headSha).toBe(head);
    expect(candidate.recommendation).not.toBe("READY FOR /prepare-pr");
    expect(candidate.correction.resolvedFindings.map((item: { id: string }) => item.id)).toEqual([
      "I2",
    ]);
  });
});
