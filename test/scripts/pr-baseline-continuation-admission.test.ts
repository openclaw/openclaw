import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBaselineFixture, reuseBaselineFixture } from "./pr-baseline-native.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;
const command = "prepare-correction-continue";
const fixture = reuseBaselineFixture((root) => {
  const f = createBaselineFixture(root, 1);
  const incoming = f.publish();
  const foreignKey = join(f.root, "main-signer");
  expect(
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", foreignKey], { env: f.env })
      .status,
  ).toBe(0);
  f.git(
    f.repo,
    "-c",
    "user.signingKey=" + foreignKey,
    "commit",
    "--allow-empty",
    "-qm",
    "test: canonical main with another signer",
  );
  const baseline = f.git(f.repo, "rev-parse", "HEAD");
  const signature = spawnSync("git", ["verify-commit", baseline], {
    cwd: f.worktree,
    env: f.env,
    encoding: "utf8",
  });
  expect(signature.status).not.toBe(0);
  expect(signature.stderr).toContain('Good "git" signature');
  expect(signature.stderr).toContain("No principal matched");
  // Only the normal producer authenticates main and signs the source/baseline binding.
  f.pass("prepare-baseline-refresh", ["--expected-head", incoming, "--baseline", baseline]);
  const head = f.prepGit("rev-parse", "HEAD");
  const tree = f.prepGit("rev-parse", "HEAD^{tree}");
  const review = validReview(incoming);
  review.recommendation = "NEEDS WORK";
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I2",
    severity: "IMPORTANT",
    title: "Required proof remains",
    area: f.product[0]!,
    fix: "Obtain the required proof",
  });
  f.writeLocal("review.json", JSON.stringify(review));
  f.writeLocal("pr-meta.json", JSON.stringify({ ...f.meta, headRefOid: incoming }));
  f.writeLocal(
    "pr-meta.env",
    [
      "PR_NUMBER=42",
      "PR_HEAD=topic",
      "PR_HEAD_SHA=" + incoming,
      "PR_HEAD_REPO_URL=https://github.com/fixture/repo",
      "",
    ].join("\n"),
  );
  const oid = (name: string) => f.prepGit("hash-object", "--no-filters", f.local(name));
  const args = Object.entries({
    "expected-head": head,
    "expected-tree": tree,
    "incoming-head": incoming,
    "incoming-review": oid("review.json"),
    "publication-receipt": "push",
    "publication-oid": oid("prepare-push-result.env"),
  }).flatMap(([name, value]) => ["--" + name, value]);
  const effects = f.local("effects");
  const gitAdapter = f.local("observed-git");
  writeFileSync(
    gitAdapter,
    `#!/bin/sh
if [ "$1" = push ]; then echo push >> "${effects}"; fi
exec git "$@"
`,
    { mode: 0o755 },
  );
  const gh = join(f.root, "bin/gh");
  writeFileSync(
    gh,
    readFileSync(gh, "utf8").replace(
      "const args = process.argv.slice(2);",
      "const args = process.argv.slice(2);\n" +
        `if (args[0] === "api" && args[1] === "graphql" && !args.some(arg => arg.startsWith("query=query("))) fs.appendFileSync(${JSON.stringify(effects)}, "graphql\\n");`,
    ),
  );
  const env = { OPENCLAW_PR_GIT: gitAdapter };
  const before = f.snapshot([
    "prep-context.env",
    "prepare-baseline.json",
    "prepare-push-result.env",
    "review.json",
  ]);
  return { ...f, baseline, incoming, head, tree, args, env: { ...f.env, ...env }, before, effects };
});

function retained(f: ReturnType<typeof fixture>, head = f.head) {
  expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.incoming);
  expect(f.prepGit("rev-parse", "HEAD")).toBe(head);
  expect(f.prepGit("write-tree")).toBe(f.tree);
  expect(existsSync(f.effects)).toBe(false);
  expect(
    f.git(f.repo, "for-each-ref", "--format=%(objectname)", "refs/openclaw/pr-merge-outcomes/"),
  ).toBe("");
}

function run(f: ReturnType<typeof fixture>, args = f.args, extra: NodeJS.ProcessEnv = {}) {
  return f.run(command, args, { ...f.env, ...extra });
}

function selectedHead(f: ReturnType<typeof fixture>, head: string) {
  f.prepGit("update-ref", "refs/heads/pr-42-prep", head, f.head);
  return f.args.map((value, index) => (f.args[index - 1] === "--expected-head" ? head : value));
}

describePosix("authenticated baseline continuation admission", () => {
  it("continues without locally trusting inherited main, then requires fresh review before publication", () => {
    const f = fixture();
    const result = run(f);
    retained(f);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.readLocal("review.json")).toEqual(f.before["review.json"]);
    expect(existsSync(f.local("correction-review.json"))).toBe(false);
    expect(existsSync(f.local("gates.env"))).toBe(false);
    const blocked = f.run("prepare-push", [], f.env);
    expect(blocked.status).not.toBe(0);
    retained(f);
    f.approve();
    f.preparePublication();
    const published = f.run("prepare-push", [], f.env);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
    expect(readFileSync(f.effects, "utf8")).toBe("push\n");
  });

  it("authenticates the same baseline when the historical incoming-review copy remains", () => {
    const f = fixture();
    const record = JSON.parse(f.readLocal("prepare-baseline.json").toString());
    f.writeLocal(
      "correction-incoming-review.json",
      readFileSync(join(f.worktree, record.archive, "correction-incoming-review.json")),
    );
    const result = run(f);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    retained(f);
  });

  it.each([
    "missing",
    "forged",
    "unbound",
    "wrong-anchor",
    "wrong-base",
    "wrong-repo",
    "stale-lease",
    "candidate-changed",
    "nonancestor",
    "unsigned-task",
    "unsigned-side",
    "unadmitted-main",
    "forged-signed-baseline",
  ])("refuses %s before publication or authority replacement", (fault) => {
    const f = fixture();
    let args = f.args;
    let head = f.head;
    if (fault === "missing") {
      rmSync(f.local("prepare-baseline.json"));
    } else if (fault === "forged") {
      const binding = JSON.parse(f.readLocal("prepare-baseline.json").toString());
      binding.baselineHead = f.incoming;
      f.writeLocal("prepare-baseline.json", JSON.stringify(binding));
    } else if (fault === "unbound" || fault === "wrong-anchor") {
      const context = f.readLocal("prep-context.env").toString();
      f.writeLocal(
        "prep-context.env",
        fault === "unbound"
          ? context.replace(/^PREP_BASELINE_REFRESH_(?:HEAD|OID)=.*\n/gmu, "")
          : context.replace(
              /^PREP_BASELINE_REFRESH_HEAD=.*$/mu,
              "PREP_BASELINE_REFRESH_HEAD=" + f.incoming,
            ),
      );
    } else if (fault === "wrong-base" || fault === "wrong-repo" || fault === "stale-lease") {
      const owner = fault === "wrong-repo" ? "elsewhere" : "fixture";
      const repo = {
        id: 1,
        node_id: "R_fixture",
        full_name: owner + "/repo",
        name: "repo",
        html_url: "https://github.com/" + owner + "/repo",
        owner: { login: owner },
      };
      const overrides =
        fault === "stale-lease"
          ? { head: { ref: "topic", sha: f.meta.headRefOid, repo } }
          : { base: { ref: fault === "wrong-base" ? "release" : "main", sha: f.baseline, repo } };
      mkdirSync(join(f.repo, ".local"), { recursive: true });
      // The real live-read adapter supplies drift, not a forged native receipt.
      writeFileSync(join(f.repo, ".local/live.json"), JSON.stringify(overrides));
    } else if (fault === "forged-signed-baseline") {
      // A locally valid signature cannot authenticate a private side branch as main.
      const side = f.prepGit(
        "commit-tree",
        "--no-gpg-sign",
        f.baseline + "^{tree}",
        "-p",
        f.baseline,
        "-m",
        "test: private unsigned history",
      );
      const record = JSON.parse(f.readLocal("prepare-baseline.json").toString());
      record.baselineHead = side;
      record.capturedMain = side;
      f.writeLocal("prepare-baseline.json", JSON.stringify(record));
      const oid = f.prepGit("hash-object", "--no-filters", f.local("prepare-baseline.json"));
      head = f.prepGit(
        "commit-tree",
        "-S",
        f.tree,
        "-p",
        record.sourceHead,
        "-p",
        side,
        "-m",
        "test: forged baseline claim\n\nBaseline-Refresh: " + oid,
      );
      f.writeLocal(
        "prep-context.env",
        f
          .readLocal("prep-context.env")
          .toString()
          .replace(/^PREP_BASELINE_REFRESH_HEAD=.*$/mu, "PREP_BASELINE_REFRESH_HEAD=" + head)
          .replace(/^PREP_BASELINE_REFRESH_OID=.*$/mu, "PREP_BASELINE_REFRESH_OID=" + oid),
      );
      args = selectedHead(f, head);
    } else if (fault === "unadmitted-main") {
      // Reuse the actual pre-refresh evidence, not a manufactured admission.
      const binding = JSON.parse(f.readLocal("prepare-baseline.json").toString());
      for (const name of ["prep-context.env", "correction-incoming-review.json"]) {
        f.writeLocal(name, readFileSync(join(f.worktree, binding.archive, name)));
      }
      rmSync(f.local("prepare-baseline.json"));
      head = f.prepGit(
        "commit-tree",
        "-S",
        f.tree,
        "-p",
        f.incoming,
        "-p",
        f.baseline,
        "-m",
        "test: ordinary main merge without native admission",
      );
      args = selectedHead(f, head);
    } else if (fault === "candidate-changed") {
      args = f.args.map((value, index) =>
        f.args[index - 1] === "--expected-tree" ? "a".repeat(40) : value,
      );
    } else {
      const unsigned = fault !== "nonancestor";
      const parent =
        fault === "nonancestor" ? f.incoming : fault === "unsigned-side" ? f.baseline : f.head;
      head = f.prepGit(
        "commit-tree",
        ...(unsigned ? ["--no-gpg-sign"] : ["-S"]),
        f.tree,
        "-p",
        parent,
        "-m",
        "test: selected descendant",
      );
      if (fault === "unsigned-side") {
        head = f.prepGit(
          "commit-tree",
          "-S",
          f.tree,
          "-p",
          f.head,
          "-p",
          head,
          "-m",
          "test: signed merge of unsigned task",
        );
      }
      args = selectedHead(f, head);
    }
    const before = f.readLocal("prep-context.env");
    const result = run(f, args);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    retained(f, head);
    expect(f.readLocal("prep-context.env")).toEqual(before);
    expect(f.readLocal("review.json")).toEqual(f.before["review.json"]);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    if (fault.startsWith("unsigned") || fault === "unadmitted-main") {
      expect(result.stderr + result.stdout).toContain("verify-commit");
    }
    if (fault === "unadmitted-main") {
      expect(result.stderr + result.stdout).toContain("No principal matched");
    }
    if (fault === "wrong-base") {
      expect(result.stderr + result.stdout).toContain("only support PRs targeting main");
    }
    if (fault === "wrong-repo") {
      expect(result.stderr + result.stdout).toContain("base repository does not match");
    }
    if (fault === "stale-lease") {
      expect(result.stderr + result.stdout).toContain("PR head changed");
    }
  });

  it("revalidates the same signed admission during interrupted retirement recovery", () => {
    const f = fixture();
    const hook = f.local("interrupt.mjs");
    writeFileSync(
      hook,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/correction-continuation.mjs') && process.argv[2] === 'apply') {
  const remove = fs.unlinkSync;
  fs.unlinkSync = function(path) {
    const result = remove.call(this, path);
    if (path === '.local/prepare-baseline.json') throw new Error('fixture interrupted retirement');
    return result;
  };
  syncBuiltinESMExports();
}
`,
    );
    const failed = run(f, f.args, { NODE_OPTIONS: "--import=" + hook });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout + failed.stderr).toContain("fixture interrupted retirement");
    retained(f);
    const bytes = f.readLocal("review-transition.json");
    const journal = JSON.parse(bytes.toString());
    const path = join(f.worktree, journal.continuation.archive, "prepare-baseline.json");
    const binding = readFileSync(path);
    writeFileSync(path, Buffer.concat([binding, Buffer.from("\n")]));
    const changed = run(f);
    expect(changed.status).not.toBe(0);
    expect(changed.stdout + changed.stderr).toContain("Retained continuation evidence changed");
    expect(f.readLocal("review-transition.json")).toEqual(bytes);
    retained(f);
    writeFileSync(path, binding);
    // Recovery must authenticate main again, not trust the journal's old claim.
    const currentMain = f.git(f.repo, "rev-parse", "refs/heads/main");
    f.git(f.repo, "update-ref", "refs/heads/main", f.meta.baseRefOid, currentMain);
    const staleMain = run(f);
    expect(staleMain.status).not.toBe(0);
    expect(staleMain.stdout + staleMain.stderr).toContain("merge-base --is-ancestor");
    expect(f.readLocal("review-transition.json")).toEqual(bytes);
    retained(f);
    f.git(f.repo, "update-ref", "refs/heads/main", currentMain, f.meta.baseRefOid);
    const recovered = run(f);
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    retained(f);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(f.readLocal("review.json")).toEqual(f.before["review.json"]);
  });
});
