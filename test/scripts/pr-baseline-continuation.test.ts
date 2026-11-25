import * as fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";
import { reviewWithFinding } from "./pr-correction-preparation.test-support.js";

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
  const json = (name: string) => JSON.parse(read(name).toString());
  const absent = (name: string) => expect(fs.existsSync(f.local(name))).toBe(false);
  const withFile = (path: string, bytes: string | Buffer, check: () => void) => {
    const previous = fs.readFileSync(path);
    try {
      fs.writeFileSync(path, bytes);
      check();
    } finally {
      fs.writeFileSync(path, previous);
    }
  };
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
    lineage = json("prepare-baseline.json").archive;
    absent("correction-incoming-review.json");
    original = f.snapshot(["pr-meta.json", "pr-meta.env", "review.json"]);
  });

  it("refuses failed metadata retention before replacing either active identity file", () => {
    const cp = join(f.root, "bin/cp");
    fs.writeFileSync(
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
      fs.unlinkSync(cp);
      git("switch", "-q", "pr-42-prep");
    }
    retained();
  });

  it("retains exact prior identity through the ordinary fresh hosted review flow", () => {
    f.pass("review-init");
    const archives = fs
      .readdirSync(f.local(""))
      .filter((name) => name.startsWith("review-evidence."));
    expect(
      archives.some((archive) =>
        Object.entries(original).every(([name, bytes]) => {
          const path = f.local(`${archive}/${name}`);
          return fs.existsSync(path) && fs.readFileSync(path).equals(bytes);
        }),
      ),
    ).toBe(true);
    f.pass("review-checkout-pr");
    f.pass("review-artifacts-init");
    const review = reviewWithFinding(incoming, f.product[0]!, "I2");
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
    const path = join(historical, "prep-context.env");
    withFile(path, Buffer.concat([fs.readFileSync(path), Buffer.from("\n")]), () => {
      expect(reject()).toContain("Retained publication lineage changed");
      f.expectSnapshot(active);
    });
    const elsewhere = `${historical}-elsewhere`;
    fs.renameSync(historical, elsewhere);
    try {
      fs.symlinkSync(elsewhere, historical);
      expect(reject()).toContain("Invalid retained proof directory");
      f.expectSnapshot(active);
    } finally {
      fs.unlinkSync(historical);
      fs.renameSync(elsewhere, historical);
    }
    withFile(
      f.local("prepare-baseline.json"),
      JSON.stringify({
        ...json("prepare-baseline.json"),
        archive: ".local/prep-evidence.foreign",
      }),
      () => expect(reject()).toContain("Retained baseline binding differs"),
    );
    f.expectSnapshot(active);
  });

  it("rechecks historical lineage after the live read and replays only the same current snapshot", () => {
    const hook = f.local("lineage-io.mjs");
    fs.writeFileSync(
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
    withFile(contextPath, fs.readFileSync(contextPath), () => {
      expect(reject({ ...extra, FIXTURE_EFFECT: "lineage-drift" })).toContain(
        "Retained publication lineage changed",
      );
      absent("review-transition.json");
    });
    expect(reject({ ...extra, FIXTURE_EFFECT: "partial" })).toContain(
      "fixture interrupted retirement",
    );
    const journal = read("review-transition.json");
    expect(json("review-transition.json").continuation.lineage.archive).toBe(lineage);
    absent("prepare-baseline.json");
    const changed = args.map((value, i) =>
      args[i - 1] === "--expected-tree" ? "a".repeat(40) : value,
    );
    expect(reject({}, changed)).toContain("Selected continuation differs");
    expect(read("review-transition.json")).toEqual(journal);
    f.pass("prepare-correction-continue", args);
    retained();
    absent("review-transition.json");
    expect(read("prep-context.env").toString()).toContain(`PR_HEAD_SHA_BEFORE='${incoming}'`);
    expect(read("prep-context.env").toString()).not.toContain("PREP_BASELINE_REFRESH");
  });
});
