import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const templates = useAutoCleanupTempDirTracker(afterAll);
const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
let seed: { root: string; source: string } | undefined;
const ref = "refs/openclaw/pr-workflow-bindings/123";
const inline = readFileSync("scripts/pr", "utf8")
  .split("<<'EOF_WRAPPER_GIT'\n")[1]
  ?.split("\nEOF_WRAPPER_GIT")[0];
if (!inline) {
  throw new Error("Missing dependency-free wrapper Git owner");
}

function fixture() {
  const root = realpathSync(temps.make("pr-workflow-binding-"));
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // Automatic maintenance must not race copying the completed seed.
    GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
    GIT_AUTHOR_NAME: "Workflow Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Workflow Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, { cwd: root, env, input, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  let source: string;
  if (seed) {
    cpSync(seed.root, root, copyOptions);
    source = seed.source;
  } else {
    git(["init", "-q", "-b", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    git(["remote", "add", "origin", "https://github.com/fixture/repo.git"]);
    git(["commit", "--allow-empty", "-qm", "fixture workflow"]);
    source = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", source]);

    const templateRoot = realpathSync(templates.make("pr-workflow-binding-template-"));
    // Capture before any binding writes; every copy owns its mutable Git files.
    cpSync(root, templateRoot, copyOptions);
    seed = { root: templateRoot, source };
  }
  const record = {
    version: 1,
    repository: "https://github.com/fixture/repo.git",
    owner: realpathSync(join(root, ".git")),
    pr: "123",
    source,
  };
  const run = (operation: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--input-type=module", "-", "git", operation, root, "123", ...args],
      {
        cwd: root,
        env,
        input: inline,
        encoding: "utf8",
      },
    );
  const write = (value: unknown, parents = [source], extra = "") => {
    const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(value));
    const tree = git(["mktree"], `100644 blob ${blob}\tbinding.json\n${extra}`);
    const commit = git(
      ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
      "binding\n",
    );
    git(["update-ref", ref, commit]);
    return commit;
  };
  return { root, git, source, record, run, write };
}

describe.skipIf(process.platform === "win32")("native workflow binding storage", () => {
  it.each([
    "valid",
    "before binding",
    "divergent",
    "unlanded",
    "stale main",
    "nonofficial",
    "changed review",
    "changed binding",
    "replaced binding",
    "symbolic binding",
    "symbolic main",
    "retained outcome",
  ])("authenticates an exact reviewed proof source: %s", (fault) => {
    const f = fixture();
    const next = (parent: string, message: string) =>
      f.git(["commit-tree", `${parent}^{tree}`, "-p", parent], message);
    const bound = next(f.source, "bound workflow");
    const reviewed = next(bound, "reviewed workflow");
    const main = next(reviewed, "later main");
    const official = "https://github.com/openclaw/openclaw.git";
    f.git([
      "remote",
      "set-url",
      "origin",
      fault === "nonofficial" ? f.record.repository : official,
    ]);
    const binding = f.write(
      {
        ...f.record,
        repository: fault === "nonofficial" ? f.record.repository : official,
        source: bound,
      },
      [bound],
    );
    f.git(["update-ref", "refs/remotes/origin/main", main]);
    const source =
      fault === "before binding"
        ? f.source
        : fault === "divergent"
          ? next(f.source, "divergent workflow")
          : fault === "unlanded"
            ? next(main, "private workflow")
            : reviewed;
    const path = join(f.root, "review.json");
    const bytes = JSON.stringify({
      correction: {
        proofPublication: {
          version: 1,
          kind: "published-candidate-proof",
          workflowSource: source,
          workflowBinding: fault === "changed binding" ? f.source : binding,
        },
      },
    });
    writeFileSync(path, bytes + (fault === "changed review" ? "\n" : ""));
    const review = f.git(["hash-object", "--stdin"], bytes);
    if (fault === "symbolic main")
      f.git(["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    if (fault === "retained outcome")
      f.git(["update-ref", "refs/openclaw/pr-merge-outcomes/123", main]);
    if (fault === "symbolic binding") {
      f.git(["update-ref", "refs/openclaw/other-binding", binding]);
      f.git(["symbolic-ref", ref, "refs/openclaw/other-binding"]);
    }
    if (fault === "stale main") f.git(["update-ref", "refs/remotes/origin/main", bound]);
    let selected = f.run("workflow-proof-select", review, path);
    if (fault === "stale main") {
      expect(selected.status).toBe(1);
      expect(selected.stderr).toContain(
        "Reviewed proof workflow is absent from cached official main",
      );
      expect(f.git(["rev-parse", ref])).toBe(binding);
      f.git(["update-ref", "refs/remotes/origin/main", main]);
      selected = f.run("workflow-proof-select", review, path);
    }
    const selectedBeforeDrift = ["valid", "replaced binding", "stale main"].includes(fault);
    expect(selected.status, selected.stderr).toBe(selectedBeforeDrift ? 0 : 1);
    let retainedBinding = binding;
    if (selectedBeforeDrift) {
      expect(selected.stdout).toBe(`${binding}\t${reviewed}\n`);
      if (fault === "replaced binding") {
        retainedBinding = f.write({ ...f.record, repository: official, source: reviewed }, [
          reviewed,
        ]);
      }
      // The locked operation consumes its captured commit, not a later shared-ref read.
      f.git(["update-ref", "refs/remotes/origin/main", f.source]);
      const admitted = f.run(
        "workflow-admit",
        reviewed,
        binding,
        main,
        "",
        "",
        "proof-baseline",
        "",
        "merge",
        review,
        path,
      );
      expect(admitted.status, admitted.stderr).toBe(fault === "replaced binding" ? 1 : 0);
      if (fault !== "replaced binding") expect(admitted.stdout).toBe(binding);
      // Ordinary current-workflow admission retains its exact-main requirement.
      expect(f.run("workflow-admission-provenance", "", "", main, reviewed).status).toBe(1);
    }
    expect(f.git(["rev-parse", ref])).toBe(retainedBinding);
  });

  it.each(["valid", "review", "tree", "snapshot", "predecessor", "parent order"])(
    "validates successor history including its %s continuation",
    (fault) => {
      const f = fixture();
      const previous = f.write(f.record);
      const source = f.git(
        ["commit-tree", `${f.source}^{tree}`, "-p", f.source],
        "next workflow\n",
      );
      f.git(["update-ref", "refs/remotes/origin/main", source]);
      const review = f.git(["hash-object", "-w", "--stdin"], "review bytes\n");
      const snapshot = f.git(
        ["hash-object", "-w", "--stdin"],
        `.local/correction-review.json ${review}`,
      );
      const record = {
        ...f.record,
        version: 2,
        source,
        predecessor: previous,
        continuation: {
          head: f.source,
          hostedHead: f.source,
          tree: f.git(["rev-parse", `${f.source}^{tree}`]),
          review,
          snapshot,
        },
      };
      if (fault === "review") {
        record.continuation.review = source;
      }
      if (fault === "tree") {
        record.continuation.tree = source;
      }
      if (fault === "snapshot") {
        record.continuation.snapshot = review;
      }
      if (fault === "predecessor") {
        record.predecessor = source;
      }
      const parents = [previous, source, f.source];
      if (fault === "parent order") {
        parents.reverse();
      }
      const next = f.write(record, parents, `100644 blob ${snapshot}\treview-snapshot\n`);
      const result = f.run("workflow-read");
      expect(result.status, result.stderr).toBe(fault === "valid" ? 0 : 1);
      if (fault === "valid") {
        expect(result.stdout).toBe(`${next}\t${source}\n`);
        expect(f.run("workflow-history", previous, f.source).stdout).toBe(f.source);
        expect(f.run("workflow-history", next, source).stdout).toBe(source);
        expect(f.run("workflow-history", next, f.source).status).toBe(1);
      }
      expect(f.git(["rev-parse", ref])).toBe(next);
    },
  );

  it.each([
    ["writer@example.invalid:Org/repo.git", "other@example.invalid:Org/repo.git"],
    ["example.invalid:Org/repo.git", "other.invalid:Org/repo.git"],
    ["example.invalid:Org/repo.git", "example.invalid:org/repo.git"],
    ["example.invalid:Org/repo.git", "example.invalid:/Org/repo.git"],
    [
      "ssh://writer@example.invalid:2222/Org/repo.git",
      "ssh://writer@example.invalid:2223/Org/repo.git",
    ],
    ["https://example.invalid:8443/Org/repo.git", "https://example.invalid:8444/Org/repo.git"],
  ])("binds %s without accepting a different endpoint %s", (remote, changed) => {
    const f = fixture();
    f.git(["remote", "set-url", "origin", remote]);
    const admitted = f.run("workflow-admit", f.source, "");
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(f.run("workflow-read").stdout).toBe(`${admitted.stdout}\t${f.source}\n`);
    f.git(["remote", "set-url", "origin", changed]);
    expect(f.run("workflow-read").status).toBe(1);
    expect(f.git(["rev-parse", ref])).toBe(admitted.stdout);
  });

  it("resolves a bare relative local origin without treating it as a URL", () => {
    const f = fixture();
    f.git(["remote", "set-url", "origin", "."]);
    const admitted = f.run("workflow-admit", f.source, "");
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(JSON.parse(f.git(["show", `${ref}:binding.json`])).repository).toBe(f.root);
  });

  it("refuses a competing initial admission and preserves the winner during stale retirement", () => {
    const f = fixture();
    const winner = f.run("workflow-admit", f.source, "");
    expect(winner.status, winner.stderr).toBe(0);
    const loser = f.run("workflow-admit", f.source, "");
    expect(loser.status).toBe(1);
    expect(loser.stderr).toContain("changed before admission");
    expect(f.run("workflow-retire", f.source).status).toBe(1);
    expect(f.git(["rev-parse", ref])).toBe(winner.stdout);
    expect(f.run("workflow-retire", winner.stdout).status).toBe(0);
    expect(f.run("workflow-read").stdout).toBe("");
  });

  it("does not admit a source outside the trusted main history", () => {
    const f = fixture();
    const unrelated = f.git(["commit-tree", `${f.source}^{tree}`], "unrelated workflow\n");
    expect(f.run("workflow-admit", unrelated, "").status).toBe(1);
    expect(f.run("workflow-read").stdout).toBe("");
  });

  it.each(["owner", "repository", "pr", "version", "source", "extra"])(
    "rejects a mismatched %s without replacing the record",
    (field) => {
      const f = fixture();
      const current = f.write({ ...f.record, [field]: "other" });
      const result = f.run("workflow-read");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("identity mismatch");
      expect(f.run("workflow-admit", f.source, current).status).toBe(1);
      expect(f.git(["rev-parse", ref])).toBe(current);
    },
  );

  it.each([
    "no parent",
    "different parent",
    "extra entry",
    "symbolic ref",
    "dangling symbolic ref",
    "blob ref",
    "source commit",
    "oversized",
  ])("rejects a %s binding before selecting code", (fault) => {
    const f = fixture();
    if (fault === "no parent") {
      f.write(f.record, []);
    } else if (fault === "different parent") {
      const parent = f.git(["commit-tree", `${f.source}^{tree}`, "-p", f.source], "other\n");
      f.write(f.record, [parent]);
    } else if (fault === "extra entry") {
      const blob = f.git(["hash-object", "-w", "--stdin"], "extra");
      f.write(f.record, [f.source], `100644 blob ${blob}\textra\n`);
    } else if (fault === "symbolic ref") {
      const commit = f.write(f.record);
      f.git(["update-ref", "refs/openclaw/other-binding", commit]);
      f.git(["symbolic-ref", ref, "refs/openclaw/other-binding"]);
    } else if (fault === "dangling symbolic ref") {
      f.git(["symbolic-ref", ref, "refs/openclaw/missing-binding"]);
      expect(f.run("workflow-admit", f.source, "").status).toBe(1);
      expect(f.git(["symbolic-ref", ref])).toBe("refs/openclaw/missing-binding");
    } else if (fault === "blob ref") {
      f.git(["update-ref", ref, f.git(["hash-object", "-w", "--stdin"], "not a commit")]);
    } else if (fault === "source commit") {
      f.git(["update-ref", ref, f.source]);
      for (const result of [
        f.run("workflow-read"),
        f.run("workflow-history", f.source, f.source),
      ]) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Invalid workflow binding tree");
      }
      expect(f.git(["rev-parse", ref])).toBe(f.source);
    } else {
      f.write({ ...f.record, extra: "x".repeat(4096) });
    }
    expect(f.run("workflow-read").status).toBe(1);
  });
});
