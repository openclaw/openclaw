import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPublisherRepoFactory, runPublisher } from "./pr-prepare.test-support.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const makeRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates,
});
let key: string;
function fixture(signed: boolean, merge: boolean, mode = "auto", allow = false) {
  const f = makeRepo();
  f.env.OPENCLAW_PR_PUSH_MODE = mode;
  f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = allow ? "1" : "";
  if (!key) {
    key = join(templates.make("openclaw-pr-fixture-signer-"), "key");
    expect(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status).toBe(0);
    writeFileSync(
      key + ".allowed",
      "fixture@example.invalid " + readFileSync(key + ".pub", "utf8"),
    );
  }
  for (const [name, value] of Object.entries({
    "gpg.format": "ssh",
    "user.signingKey": key,
    "gpg.ssh.allowedSignersFile": key + ".allowed",
  })) {
    f.git("config", name, value);
  }
  const commit = (tree: string, parents: string[]) =>
    f.git(
      "commit-tree",
      ...(signed ? ["-S"] : []),
      tree + "^{tree}",
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      "prepared fixture",
    );
  const parents = [f.source];
  if (merge) {
    parents.push(commit(f.source, [f.source]));
  }
  f.candidate = commit(f.candidate, parents);
  f.git("reset", "--hard", f.candidate);
  f.write(
    "gates.env",
    "PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=" + f.candidate + "\n",
  );
  return f;
}
const metadata = ["PR_HEAD_OWNER=fixture", "PR_HEAD_REPO_NAME=repo"];
const hosted = (f: ReturnType<typeof fixture>) =>
  f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");

it.each([
  [true, false, false, "push"],
  [true, false, true, "push"],
  [true, true, false, "push"],
  [true, true, true, "push"],
  [false, false, false, "graphql"],
  [false, false, true, "graphql"],
  [false, true, false, "refuse"],
  [false, true, true, "push"],
] as const)(
  "auto routes signed=%s merge=%s allow=%s through %s",
  (signed, merge, allow, expected) => {
    const f = fixture(signed, merge, "auto", allow);
    const result = runPublisher(f, undefined, metadata);
    expect(result.status, result.stdout + result.stderr).toBe(expected === "refuse" ? 2 : 0);
    expect(f.read("events")).toBe(expected === "refuse" ? "" : expected + "\n");
    if (expected === "refuse") {
      expect(hosted(f)).toBe(f.source);
      expect(result.stdout).toContain("Refusing git-protocol PR branch push");
    } else {
      expect(hosted(f) === f.candidate).toBe(expected === "push");
      expect(f.git("rev-parse", hosted(f) + "^{tree}")).toBe(
        f.git("rev-parse", f.candidate + "^{tree}"),
      );
    }
  },
);

it.each([
  [false, false, "git", false, 2],
  [false, false, "git", true, 0],
  [true, false, "graphql", false, 0],
  [true, true, "graphql", true, 1],
  [false, true, "graphql", true, 1],
] as const)(
  "honors explicit mode for signed=%s merge=%s mode=%s allow=%s",
  (signed, merge, mode, allow, code) => {
    const f = fixture(signed, merge, mode, allow);
    const result = runPublisher(f, undefined, metadata);
    expect(result.status, result.stdout + result.stderr).toBe(code);
    expect(f.read("events")).toBe(code ? "" : mode === "git" ? "push\n" : "graphql\n");
    if (code) {
      expect(hosted(f)).toBe(f.source);
      expect(result.stdout).toContain(
        code === 1 ? "cannot preserve merge ancestry" : "Refusing git-protocol PR branch push",
      );
    }
  },
);

it.each([false, true])("restricts permission fallback to linear history (merge=%s)", (merge) => {
  const f = fixture(true, merge);
  const result = runPublisher(f, undefined, [
    ...metadata,
    'pr_git() { if [ "$1" = push ]; then echo push >> .local/events; echo "403 permission denied" >&2; return 73; fi; command git "$@"; }',
  ]);
  expect(result.status, result.stdout + result.stderr).toBe(merge ? 73 : 0);
  expect(f.read("events")).toBe(merge ? "push\n" : "push\ngraphql\n");
  if (merge) {
    expect(hosted(f)).toBe(f.source);
    expect(result.stdout).toContain("403 permission denied");
    expect(result.stdout).not.toContain("trying GraphQL");
  } else {
    expect(f.git("rev-parse", hosted(f) + "^{tree}")).toBe(
      f.git("rev-parse", f.candidate + "^{tree}"),
    );
  }
});

it.each([false, true])("never replays a Git write whose response was lost (merge=%s)", (merge) => {
  const f = fixture(true, merge);
  const result = runPublisher(f, undefined, [
    ...metadata,
    'pr_git() { if [ "$1" = push ]; then echo push >> .local/events; command git "$@" || return $?; echo "connection lost after write" >&2; return 74; fi; command git "$@"; }',
  ]);
  expect(result.status, result.stdout + result.stderr).toBe(74);
  expect(hosted(f)).toBe(f.candidate);
  expect(f.read("events")).toBe("push\n");
  expect(f.exists("prepare-sync-result.env")).toBe(false);
});

it.each([false, true])(
  "limits merge capability to the unpublished range (hosted=%s)",
  (alreadyHosted) => {
    const f = fixture(false, true, "auto", true);
    if (alreadyHosted) {
      f.git("push", "-q", "origin", f.candidate + ":refs/heads/topic");
      f.source = f.candidate;
      f.write(
        "prep-context.env",
        f.read("prep-context.env").replace(f.observation.headRefOid, f.source),
      );
    }
    f.git("commit", "--allow-empty", "--no-gpg-sign", "-qm", "linear fixup");
    f.candidate = f.git("rev-parse", "HEAD");
    const result = runPublisher(f, undefined, metadata);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.read("events")).toBe(alreadyHosted ? "graphql\n" : "push\n");
    expect(hosted(f) === f.candidate).toBe(!alreadyHosted);
  },
);
