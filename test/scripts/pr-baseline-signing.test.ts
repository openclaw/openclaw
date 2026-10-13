import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("native baseline signing handoff", () => {
  let f: ReturnType<typeof createBaselineFixture>;
  beforeAll(() => {
    f = createBaselineFixture(dirs.make("openclaw-pr-signing-"));
  });

  it("seals a request, rejects changed inputs, and recovers the same separately signed successor", () => {
    f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("initial upstream")));
    f.approve();
    const source = f.git(f.worktree, "rev-parse", "HEAD");
    const baseline = f.advanceMain("next upstream", [f.product[0]!]);
    const signer = f.git(f.worktree, "show", "-s", "--format=%GF", "HEAD");
    const before = Object.fromEntries(
      ["prepare-baseline.json", "prep-context.env", "correction-review.json", "review.json"].map(
        (name) => [name, readFileSync(f.local(name))],
      ),
    );
    // The preparation host has verification authority but cannot sign.
    f.git(f.repo, "config", "user.signingKey", join(f.root, "unavailable-key"));
    const requestArgs = [...f.successor(baseline), "--signer", signer];
    const changeArchive = f.local("change-archive.mjs");
    writeFileSync(
      changeArchive,
      `import fs from 'node:fs';
if (process.argv[1]?.endsWith('/baseline-refresh.mjs') && process.argv[2] === 'create-signing-request') {
  const write = process.stdout.write;
  process.stdout.write = function(chunk, ...rest) {
    const result = write.call(this, chunk, ...rest);
    const request = JSON.parse(String(chunk));
    const record = JSON.parse(Buffer.from(request.binding, 'base64'));
    fs.appendFileSync(record.archive + '/prep-context.env', '\\n');
    return result;
  };
}
`,
    );
    const changed = f.run("prepare-baseline-signing-request", requestArgs, {
      NODE_OPTIONS: `--import=${changeArchive}`,
    });
    expect(changed.status, changed.stdout + changed.stderr).not.toBe(0);
    expect(changed.stderr).toContain("Retained proof changed before sealing");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(source);
    const pending = f.pass("prepare-baseline-signing-request", requestArgs);
    const oid = /Awaiting signature: request=([a-f0-9]{40})/u.exec(pending.stdout)![1]!;
    const requestPath = f.local(`prepare-baseline-signing.${oid}.json`);
    const requestBytes = readFileSync(requestPath);
    const request = JSON.parse(requestBytes.toString());
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(source);
    for (const [name, bytes] of Object.entries(before)) {
      expect(readFileSync(f.local(name))).toEqual(bytes);
    }
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    const duplicate = f.run("prepare-baseline-signing-request", requestArgs);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("Retained signing request exists");
    expect(readFileSync(requestPath)).toEqual(requestBytes);

    // A separate bare object store performs ordinary git commit-tree -S with
    // the exact identities/dates/message from the request, not signature splicing.
    const spool = join(f.root, "signer.git");
    mkdirSync(spool);
    f.git(spool, "init", "-q", "--bare");
    const unsigned = Buffer.from(request.unsignedCommit, "base64");
    const split = unsigned.indexOf("\n\n");
    const headers = unsigned.subarray(0, split).toString();
    const tree = /^tree ([a-f0-9]{40})$/mu.exec(headers)![1]!;
    const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((m) => m[1]!);
    const pack = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
      cwd: f.worktree,
      env: f.env,
      maxBuffer: 16 * 1024 * 1024,
      input: [tree, ...parents].join("\n") + "\n",
    });
    expect(pack.status, pack.stderr.toString()).toBe(0);
    const imported = spawnSync("git", ["index-pack", "--stdin"], {
      cwd: spool,
      env: f.env,
      input: pack.stdout,
    });
    expect(imported.status, imported.stderr.toString()).toBe(0);
    const identity: NodeJS.ProcessEnv = {};
    for (const role of ["author", "committer"]) {
      const [, name, email, date] = new RegExp(`^${role} (.*) <([^>]*)> (.*)$`, "mu").exec(
        headers,
      )!;
      identity[`GIT_${role.toUpperCase()}_NAME`] = name;
      identity[`GIT_${role.toUpperCase()}_EMAIL`] = email;
      identity[`GIT_${role.toUpperCase()}_DATE`] = date;
    }
    const sign = (key: string) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "gpg.format=ssh",
          "commit-tree",
          `-S${key}`,
          tree,
          ...parents.flatMap((parent) => ["-p", parent]),
        ],
        {
          cwd: spool,
          env: { ...f.env, ...identity },
          input: unsigned.subarray(split + 2),
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const target = result.stdout.trim();
      const commit = spawnSync("git", ["cat-file", "commit", target], { cwd: spool, env: f.env });
      expect(commit.status, commit.stderr.toString()).toBe(0);
      return { target, bytes: commit.stdout };
    };
    const signed = sign(f.key);
    const response = f.local("signed-commit");
    writeFileSync(response, signed.bytes);
    const args = ["--request", oid, "--signed-commit", response];
    const refuse = (message: string) => {
      const result = f.run("prepare-baseline-signing-continue", args);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
      expect(f.git(f.worktree, "rev-parse", "refs/heads/pr-42-prep")).toBe(source);
      expect(existsSync(f.local("review-transition.json"))).toBe(false);
      return result;
    };
    for (const [from, to] of [
      [source, baseline],
      ["fix: refresh", "fix: changed"],
      [identity.GIT_AUTHOR_EMAIL!, "changed@example.invalid"],
    ]) {
      writeFileSync(response, signed.bytes.toString().replace(from!, to!));
      refuse("Signed commit payload differs");
    }
    writeFileSync(response, signed.bytes);
    appendFileSync(requestPath, "\n");
    refuse("Signing request changed");
    writeFileSync(requestPath, requestBytes);

    const otherKey = join(f.root, "other-key");
    expect(
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", otherKey], { env: f.env })
        .status,
    ).toBe(0);
    appendFileSync(f.signers, `other@example.invalid ${readFileSync(`${otherKey}.pub`, "utf8")}`);
    writeFileSync(response, sign(otherKey).bytes);
    refuse("does not match the requested signing key");
    writeFileSync(response, signed.bytes);

    appendFileSync(f.local("correction-review.json"), "\n");
    refuse("Correction review authority changed");
    writeFileSync(f.local("correction-review.json"), before["correction-review.json"]!);
    const archive = JSON.parse(Buffer.from(request.binding, "base64").toString()).archive;
    const proof = join(f.worktree, archive, "correction-review.json");
    const proofBytes = readFileSync(proof);
    appendFileSync(proof, "\n");
    refuse("Retained successor proof changed");
    writeFileSync(proof, proofBytes);
    f.git(f.worktree, "switch", "-qc", "foreign-preparation");
    refuse("preparation branch changed");
    f.git(f.worktree, "switch", "-q", "pr-42-prep");
    mkdirSync(join(f.repo, ".local"), { recursive: true });
    writeFileSync(join(f.repo, ".local/live.json"), '{"state":"closed"}');
    refuse("PR identity changed");
    rmSync(join(f.repo, ".local/live.json"));

    const loseLock = f.local("lose-lock.mjs");
    writeFileSync(
      loseLock,
      `import { execFileSync } from 'node:child_process';
if (process.argv[1]?.endsWith('/baseline-refresh.mjs') && process.argv[2] === 'check-signing') {
  execFileSync('git', ['update-ref', 'refs/openclaw/pr-operation-locks/42', '${baseline}']);
}
`,
    );
    const lockDrift = f.run("prepare-baseline-signing-continue", args, {
      NODE_OPTIONS: `--import=${loseLock}`,
    });
    expect(lockDrift.status, lockDrift.stdout + lockDrift.stderr).not.toBe(0);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(source);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    // This fixture owns the deliberately corrupted ref; the real supervisor
    // must preserve it, and no fixture child remains after its joined return.
    expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toBe(baseline);
    f.git(f.repo, "update-ref", "-d", "refs/openclaw/pr-operation-locks/42", baseline);

    const failRestore = join(f.root, "fail-restore");
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      env: f.env,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      failRestore,
      `#!/bin/bash
if [ "$1" = --literal-pathspecs ] && [ "$2" = restore ]; then exit 72; fi
exec '${realGit}' "$@"
`,
      { mode: 0o755 },
    );
    const interrupted = f.run("prepare-baseline-signing-continue", args, {
      OPENCLAW_PR_GIT: failRestore,
    });
    expect(interrupted.status, interrupted.stdout + interrupted.stderr).not.toBe(0);
    const journalBytes = readFileSync(f.local("review-transition.json"));
    expect(JSON.parse(journalBytes.toString()).target).toBe(signed.target);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(source);
    expect(readFileSync(requestPath)).toEqual(requestBytes);
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(signed.target);
    expect(f.git(f.worktree, "show", "-s", "--format=%P", "HEAD")).toBe(`${source} ${baseline}`);
    f.git(f.worktree, "verify-commit", "HEAD");
    expect(readFileSync(f.local("review.json"))).toEqual(before["review.json"]);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(existsSync(f.local("correction-review.json"))).toBe(false);
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(signed.target);
  });
});
