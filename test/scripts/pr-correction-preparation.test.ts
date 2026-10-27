import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCorrectionFixture } from "./pr-correction-preparation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const executionReached =
  "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 73; }";

function receipt(hosted: string, local: string, incoming: string) {
  return `PUSH_PREP_HEAD_SHA=${hosted}\nPUSH_LOCAL_PREP_HEAD_SHA=${local}\nPUSHED_FROM_SHA=${incoming}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${hosted}\n`;
}

function fixture(phase: "incoming" | "corrected" | "approved" = "incoming") {
  const f = createCorrectionFixture(tempDirs.make("openclaw-pr-correction-"));
  if (phase !== "incoming") {
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
    f.commitFix();
  }
  if (phase === "approved") {
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
  }
  const local = (name: string) => join(f.root, ".local", name);
  const read = (name: string) => readFileSync(local(name), "utf8");
  const write = (name: string, value: string | Buffer) => writeFileSync(local(name), value);
  const check = (command: string, status = 0, env?: NodeJS.ProcessEnv) => {
    const result = f.run(command, env);
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return result;
  };
  return {
    ...f,
    shell: (...lines: string[]) => f.run(lines.join("\n")),
    read,
    write,
    check,
    has: (name: string) => existsSync(local(name)),
    target: (head = f.incoming, fork = false) =>
      `gh() { printf '%s\\n' '${JSON.stringify({ state: "OPEN", isCrossRepository: fork, baseRefName: "main", baseRefOid: f.incoming, headRefOid: head })}'; }`,
    changePlan: `derive_prepare_gate_change_plan() { PREPARE_GATE_BASE_SHA=${f.incoming}; PREPARE_GATE_CHANGED_FILES=docs/fix.md; PREPARE_GATE_DOCS_ONLY=false; PREPARE_GATE_CHANGELOG_ONLY=false; PREPARE_GATE_CHANGELOG_REQUIRED=false; PREPARE_GATE_CHANGELOG_UPDATE=false; }`,
    gates: (head: string) =>
      writeFileSync(
        local("gates.env"),
        `PR_NUMBER=42\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${head}\nFULL_GATES_HEAD_SHA=${head}\n`,
      ),
  };
}

describePosix("native correction preparation", () => {
  it.each(["OPENCLAW_PR_GIT", "GIT_EXEC"])(
    "uses configured Git for correction review initialization and validation via %s",
    (selector) => {
      const f = fixture("corrected");
      const resolved = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" });
      expect(resolved.status, resolved.stderr).toBe(0);
      const bin = join(f.root, ".local", "git-bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'unexpected PATH Git' >&2\nexit 97\n", {
        mode: 0o755,
      });
      const selectedDir = join(f.root, ".local", "selected git");
      mkdirSync(selectedDir);
      const selected = join(selectedDir, "git");
      // A configured Git may be a policy shim that resolves its backend via PATH.
      // Preserve that search while leaving direct, unconfigured calls trapped.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        selected,
        `#!/bin/sh\nexport PATH=${quote(process.env.PATH ?? "")}\nexec ${quote(resolved.stdout.trim())} "$@"\n`,
        { mode: 0o755 },
      );
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        OPENCLAW_PR_GIT: selector === "OPENCLAW_PR_GIT" ? selected : "",
        GIT_EXEC: selector === "GIT_EXEC" ? selected : "",
      };
      f.check("prepare_correction_review_init 42", 0, env);
      f.approve();
      const validated = f.check("require_prepared_review 42", 0, env);
      expect(validated.stdout).toContain("READY FOR /prepare-pr");
    },
  );

  it("preserves the observed PR through ordinary prepare-run without treating it as correction mode", () => {
    const f = fixture();
    f.review.recommendation = "READY FOR /prepare-pr";
    f.review.findings = [];
    f.write("review.json", JSON.stringify(f.review));
    const result = f.shell(
      'pr_observe() { echo "unexpected replacement observation" >&2; return 99; }',
      'prepare_gates() { [ "$1" = 42 ] && [ "$2" = "$(cat .local/pr-meta.json)" ] && touch .local/gates-reached; }',
      'prepare_push() { [ "$1" = 42 ] && [ "$2" = "$(cat .local/pr-meta.json)" ] && touch .local/push-reached; }',
      'prepare_run 42 "$(cat .local/pr-meta.json)"',
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.read("prep-context.env")).toContain("PREP_REVIEW_MODE=ready");
    expect(f.has("gates-reached")).toBe(true);
    expect(f.has("push-reached")).toBe(true);
    expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
    expect(f.run("require_prepared_review 42").status).toBe(0);
  });

  it("preserves default NEEDS WORK refusal and explicitly admits only correction preparation", () => {
    const f = fixture();
    const original = f.read("review.json");
    const denied = f.check("prepare_init 42", 1);
    expect(denied.stdout).toContain("requires a validated READY");
    expect(f.has("side-effects")).toBe(false);
    f.check("prepare_init 42 '' correction");
    expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
    expect(f.read("review.json")).toBe(original);
    expect(f.run("require_prepared_review 42").status).toBe(1);
    expect(f.has("gates.env")).toBe(false);
  });

  it.each(["NEEDS DISCUSSION", "NOT USEFUL (CLOSE)"])(
    "does not admit %s for correction",
    (recommendation) => {
      const f = fixture();
      f.review.recommendation = recommendation;
      f.write("review.json", JSON.stringify(f.review));
      f.check("prepare_init 42 '' correction", 1);
      expect(f.has("side-effects")).toBe(false);
    },
  );

  it.each(["gates", "push", "sync"])(
    "refuses %s before its execution/publication owner without candidate approval",
    (operation) => {
      const f = fixture("corrected");
      f.write("gates.env", "GATES_MODE=full\n");
      const result = f.shell(
        'source "$script_parent_dir/pr-lib/gates.sh"',
        "resolve_pr_gates_remote_mode() { echo local; }",
        "mark_pr_operation_side_effects_if_available() { :; }",
        "derive_prepare_gate_change_plan() { touch .local/execution-reached; return 1; }",
        "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 1; }",
        operation === "gates"
          ? "prepare_gates 42"
          : operation === "push"
            ? "prepare_push 42"
            : "prepare_sync_head 42",
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("correction-review.json");
      expect(f.has("execution-reached")).toBe(false);
    },
  );

  it("rejects candidate review when the corrected history drops the incoming commit", () => {
    const f = fixture("corrected");
    f.git("checkout", "--orphan", "replacement");
    f.git("add", ".");
    f.git("commit", "-qm", "rewritten source");
    f.git("branch", "-f", "pr-42-prep", "HEAD");
    expect(f.run("prepare_correction_review_init 42").status).toBe(1);
  });

  it.each(["finding resolution", "lost correction mode"])("refuses changed %s", (kind) => {
    const f = fixture("approved");
    if (kind === "lost correction mode") {
      f.write(
        "prep-context.env",
        f.read("prep-context.env").replace("PREP_REVIEW_MODE=correction", "PREP_REVIEW_MODE=ready"),
      );
    } else {
      const review = JSON.parse(f.read("correction-review.json"));
      review.correction.resolvedFindings = [];
      f.write("correction-review.json", JSON.stringify(review));
    }
    expect(f.run("require_prepared_review 42").status).toBe(1);
  });

  it.each([false, true])(
    "binds recovered approval to incoming review bytes, changed=%s",
    (changed) => {
      const f = fixture("approved");
      const candidate = f.git("rev-parse", "HEAD");
      const names = ["correction-review.json", "correction-incoming-review.json"];
      const retained = names.map((name) => ({ name, bytes: f.read(name) }));
      f.git("checkout", "--detach", f.incoming);
      if (changed) {
        const finding = f.review.findings[0]!;
        finding.fix = "A different obligation with the same I1 identifier";
        f.write("review.json", JSON.stringify(f.review));
      }
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.git("reset", "--hard", candidate);
      retained.forEach(({ name, bytes }) => f.write(name, bytes));
      const result = f.check("require_prepared_review 42", changed ? 1 : 0);
      if (changed) {
        expect(result.stderr).toContain("exact incoming review bytes");
      }
    },
  );

  it.each(["push", "sync"])("requires exact gates before correction %s", (operation) => {
    const f = fixture("approved");
    const qualified = f.git("rev-parse", "HEAD");
    const publish = () =>
      f.shell(executionReached, operation === "push" ? "prepare_push 42" : "prepare_sync_head 42");
    expect(publish().status).toBe(1);
    expect(f.has("execution-reached")).toBe(false);
    f.gates(qualified);
    f.git("commit", "-q", "--allow-empty", "-m", "new candidate same tree");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    expect(publish().status).toBe(1);
    expect(f.has("execution-reached")).toBe(false);
    const current = f.git("rev-parse", "HEAD");
    f.gates(current);
    expect(publish().status).toBe(73);
    expect(f.has("execution-reached")).toBe(true);
  });

  it.each(["completed", "pending", "revoked", "fork", "foreign-gate"])(
    "preserves correction authority when a partial publication has %s gates",
    (state) => {
      const f = fixture("approved");
      const local = f.git("rev-parse", "HEAD");
      const hosted = f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "hosted");
      f.write("prepare-push-result.env", receipt(hosted, local, f.incoming));
      const pending = ["pending", "revoked", "fork"].includes(state);
      const qualified =
        state === "foreign-gate"
          ? f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "foreign")
          : pending
            ? local
            : hosted;
      f.write(
        "gates.env",
        `PR_NUMBER=42\nGATES_MODE=${pending ? "remote_crabbox_aws_pending" : "full"}\nLAST_VERIFIED_HEAD_SHA=${qualified}\nFULL_GATES_HEAD_SHA=${qualified}\nREMOTE_GATES_PROVIDER=aws\n`,
      );
      const result = f.shell(
        "source .local/prep-context.env",
        `resolve_prep_publication_target 42 ${local}`,
        `test "$PREP_PUBLICATION_LEASE_SHA" = ${hosted}`,
        "require_prepared_review 42",
        `require_active_org_admin_for_crabbox_gate() { [ '${state}' != revoked ]; }`,
        f.target(hosted, state === "fork"),
        `require_correction_publication_gates 42 ${local} true`,
      );
      const allowed = state === "completed" || state === "pending";
      expect(result.status, result.stdout + result.stderr).toBe(allowed ? 0 : 1);
      expect(f.has("prep.env")).toBe(false);
    },
  );

  it.each([
    { fork: true, authorization: "granted" },
    { fork: false, authorization: "granted" },
    { fork: false, authorization: "denied" },
    { fork: false, authorization: "revoked" },
  ])(
    "checks native pending-route eligibility before correction publication, fork=$fork, authorization=$authorization",
    ({ fork, authorization }) => {
      const f = fixture("approved");
      const result = f.shell(
        "resolve_pr_gates_remote_mode() { echo crabbox-aws; }",
        "mark_pr_operation_side_effects_if_available() { :; }",
        `require_active_org_admin_for_crabbox_gate() {
            local phase=qualification
            [ ! -e .local/publication-started ] || phase=publication
            printf '%s\\n' "$phase" >> .local/admin-checks
            [ '${authorization}' != denied ] || return 1
            if [ '${authorization}' = revoked ] && [ "$phase" = publication ]; then return 1; fi
            echo fixture-admin
          }`,
        f.changePlan,
        f.target(f.incoming, fork),
        executionReached,
        "prepare_gates 42",
        "touch .local/publication-started",
        "prepare_push 42",
      );
      const allowed = !fork && authorization === "granted";
      expect(result.status, result.stdout + result.stderr).toBe(allowed ? 73 : 1);
      expect(f.has("execution-reached")).toBe(allowed);
      const checks = f.read("admin-checks").trim().split("\n");
      expect(checks).toContain("qualification");
      if (authorization === "denied") {
        expect(checks).not.toContain("publication");
        expect(f.has("gates.env")).toBe(false);
      } else {
        expect(checks).toContain("publication");
      }
      f.check("push_prep_head_to_pr_branch() { return 73; }; prepare_sync_head 42", 1);
    },
  );

  it("includes runtime fixup paths in candidate review even when incoming scope is docs", () => {
    const f = fixture("corrected");
    mkdirSync(join(f.root, "src"));
    writeFileSync(join(f.root, "src/fix.ts"), "export const fixed = true;\n");
    f.git("add", "src/fix.ts");
    f.git("commit", "-qm", "fix runtime");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const result = f.check("require_prepared_review 42", 1);
    expect(result.stderr).toContain("runtime file changes require");
  });

  it.each([
    ["git", "unchanged"],
    ["git", "JSON"],
    ["git", "Markdown"],
    ["graphql", "unchanged"],
    ["graphql", "JSON"],
    ["graphql", "Markdown"],
    ["git", "publication receipt"],
    ["graphql", "publication receipt"],
  ])(
    "revalidates JSON authority immediately before %s publication after %s change",
    (route, change) => {
      const f = fixture("approved");
      const head = f.git("rev-parse", "HEAD");
      f.gates(head);
      const mutation =
        change === "JSON"
          ? "printf '\\n' >> .local/correction-review.json"
          : change === "publication receipt"
            ? "printf 'changed\\n' > .local/prepare-push-result.env"
            : change === "Markdown"
              ? "printf 'obsolete presentation\\n' > .local/correction-review.md"
              : ":";
      const result = f.shell(
        'source "$script_parent_dir/pr-lib/push.sh"',
        "PREP_PUBLICATION_PR=42; PREP_PUBLICATION_ALLOW_PENDING=false",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 42)",
        'pr_git() { if [ "$1" = push ]; then touch .local/publication; return 0; fi; git "$@"; }',
        `pr_gh_plain() { touch .local/publication; printf '%s\\n' '{"data":{"createCommitOnBranch":{"commit":{"oid":"${head}"}}}}'; }`,
        `verify_prep_commit_range_signed() { ${mutation}; return 0; }`,
        `verify_prep_head_extends_hosted_head() { git merge-base --is-ancestor "$1" HEAD || return 1; ${mutation}; }`,
        "PRHEAD_REMOTE_URL=https://example.invalid/repo.git; OPENCLAW_PR_PUSH_MODE=git",
        'revalidate_pr_publication() { [ "$1" = 42 ] && [ "$2" = fixture-observation ] && [ "$3" = topic ] && [ "$5" = "$(git rev-parse HEAD)" ]; }',
        route === "git"
          ? `push_prep_head_once topic ${f.incoming} ${head} 42 fixture-observation`
          : `graphql_push_to_fork fixture/repo topic ${f.incoming} 42 fixture-observation ${head}`,
      );
      const changedAuthority = change === "JSON" || change === "publication receipt";
      expect(result.status, result.stdout + result.stderr).toBe(changedAuthority ? 1 : 0);
      expect(f.has("publication")).toBe(!changedAuthority);
      if (changedAuthority) {
        expect(result.stderr).toContain("Correction review authority changed");
      }
    },
  );

  it("retains prior candidate reviews when initializing another review", () => {
    const f = fixture("approved");
    const original = f.read("correction-review.json");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    const retained = readdirSync(join(f.root, ".local")).find((name) =>
      name.startsWith("correction-review-retained."),
    );
    expect(retained).toBeTruthy();
    expect(f.read(`${retained}/correction-review.json`)).toBe(original);
    expect(f.run("require_prepared_review 42").status).toBe(1);
  });

  it.each(["review", "publication lease", "replacement flag"])(
    "refuses a resumed no-op when %s changes during hosted acquisition",
    (change) => {
      const f = fixture("approved");
      const local = f.git("rev-parse", "HEAD");
      const hosted = f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "hosted");
      const originalReceipt = receipt(hosted, local, f.incoming);
      f.write("prepare-push-result.env", originalReceipt);
      f.gates(hosted);
      const changedReceipt =
        change === "publication lease"
          ? originalReceipt.replace(`PUSHED_FROM_SHA=${f.incoming}`, `PUSHED_FROM_SHA=${hosted}`)
          : originalReceipt.replace("=false\n", "=true\n");
      const mutation =
        change === "review"
          ? "printf '\\n' >> .local/correction-review.json"
          : `printf '%s' '${changedReceipt}' > .local/prepare-push-result.env`;
      const result = f.shell(
        'source "$script_parent_dir/pr-lib/worktree.sh"',
        'source "$script_parent_dir/pr-lib/push.sh"',
        "source .local/prep-context.env",
        "PREP_PUBLICATION_PR=42; PREP_PUBLICATION_ALLOW_PENDING=false",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 42)",
        "resolve_head_push_url() { echo https://example.invalid/repo.git; }",
        `resolve_prhead_remote_sha() { PRHEAD_REMOTE_SHA=${hosted}; }`,
        "revalidate_pr_publication() { :; }",
        `wait_for_pr_head_sha() { PR_OBSERVATION='{"headRefOid":"${hosted}"}'; }`,
        "verify_pr_publication_identity() { :; }",
        `fetch_pr_head() { git update-ref "$3" "$2"; ${mutation}; }`,
        `push_prep_head_to_pr_branch 42 topic ${hosted} ${hosted} .local/prepare-push-result.env "$(cat .local/pr-meta.json)"`,
        "touch .local/completed",
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Correction review authority changed");
      expect(f.has("completed")).toBe(false);
      expect(f.read("prepare-push-result.env")).toBe(
        change === "review" ? originalReceipt : changedReceipt,
      );
    },
  );
});
