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
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createBaselineFixture,
  failRestore,
  signBaselineRequest,
} from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function createSigningContext() {
  const f = createBaselineFixture(dirs.make("openclaw-pr-signing-"), 1);
  f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("initial upstream")));
  const credit = "Co-authored-by: Ada Example <ada@example.invalid>";
  f.prepGit("commit", "--allow-empty", "-qm", `fix: complete the reviewed correction\n\n${credit}`);
  f.approve();
  const source = f.publish();
  const baseline = f.advanceMain("next upstream", [f.product[0]!]);
  const signer = f.prepGit("show", "-s", "--format=%GF", "HEAD");
  const before = f.snapshot([
    "prepare-baseline.json",
    "prep-context.env",
    "prep.env",
    "prepare-push-result.env",
    "correction-review.json",
    "review.json",
  ]);
  // The preparation host has verification authority but cannot sign.
  f.git(f.repo, "config", "user.signingKey", join(f.root, "unavailable-key"));
  const requestArgs = [...f.successor(baseline), "--signer", signer];
  return { f, credit, source, baseline, before, requestArgs };
}

function createSignedContext() {
  const context = createSigningContext();
  const { f, credit, requestArgs } = context;
  const signed = signBaselineRequest(f, requestArgs);
  expect(signed.message).toBe(
    `fix: refresh the reviewed correction baseline\n\nBaseline-Refresh: ${signed.bindingOid}\n${credit}\n`,
  );
  return { ...context, ...signed };
}

describePosix("native baseline signing handoff", () => {
  it("seals a published successor request and rejects changed inputs", () => {
    const { f, source, before, requestArgs } = createSigningContext();
    const refuseRequest = (message: string, extra: NodeJS.ProcessEnv = {}) => {
      const result = f.run("prepare-baseline-signing-request", requestArgs, extra);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
      expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
      expect(existsSync(f.local("review-transition.json"))).toBe(false);
    };
    for (const name of ["prep.env", "prepare-push-result.env"]) {
      rmSync(f.local(name));
    }
    refuseRequest("PR head changed before publication");
    for (const name of ["prep.env", "prepare-push-result.env"]) {
      f.writeLocal(name, before[name]!);
    }
    const receipt = before["prepare-push-result.env"]!;
    rmSync(f.local("prepare-push-result.env"));
    refuseRequest("Baseline admission requires the native publication result");
    writeFileSync(
      f.local("prepare-push-result.env"),
      receipt.toString().replaceAll(source, f.incoming),
    );
    refuseRequest("Baseline admission requires the native publication result");
    const alias = f.prepGit(
      "commit-tree",
      `${source}^{tree}`,
      "-p",
      f.incoming,
      "-m",
      "test: hosted publication alias",
    );
    writeFileSync(
      f.local("prep.env"),
      before["prep.env"]!.toString().replace(`PREP_HEAD_SHA=${source}`, `PREP_HEAD_SHA=${alias}`),
    );
    writeFileSync(
      f.local("prepare-push-result.env"),
      receipt
        .toString()
        .replace(`PUSH_PREP_HEAD_SHA=${source}`, `PUSH_PREP_HEAD_SHA=${alias}`)
        .replace(`PR_HEAD_SHA_AFTER_PUSH=${source}`, `PR_HEAD_SHA_AFTER_PUSH=${alias}`),
    );
    f.git(f.repo, "update-ref", "refs/heads/topic", alias, source);
    refuseRequest("Prep sync refused rewritten history");
    f.git(f.repo, "update-ref", "refs/heads/topic", source, alias);
    f.writeLocal("prep.env", before["prep.env"]!);
    for (const replacement of [
      receipt
        .toString()
        .replace("PUSH_REPLACED_HOSTED_ANCESTRY=false", "PUSH_REPLACED_HOSTED_ANCESTRY=true"),
      receipt
        .toString()
        .replace(`PUSH_LOCAL_PREP_HEAD_SHA=${source}`, `PUSH_LOCAL_PREP_HEAD_SHA=${f.incoming}`),
    ]) {
      f.writeLocal("prepare-push-result.env", replacement);
      refuseRequest("does not match this preparation");
    }
    f.writeLocal("prepare-push-result.env", receipt);
    const changePublication = f.local("change-publication.mjs");
    writeFileSync(
      changePublication,
      `import fs from 'node:fs';
if (process.argv[1]?.endsWith('/gh')) {
  const write = process.stdout.write;
  process.stdout.write = function(chunk, ...rest) {
    const result = write.call(this, chunk, ...rest);
    if (String(chunk).includes('PR_fixture')) {
      const receipt = process.env.FIXTURE_WORKTREE + '/.local/prepare-push-result.env';
      const lines = fs.readFileSync(receipt, 'utf8').trimEnd().split('\\n');
      fs.writeFileSync(receipt, lines.reverse().join('\\n') + '\\n');
    }
    return result;
  };
}
`,
    );
    refuseRequest("Correction review authority changed during admission", {
      NODE_OPTIONS: `--import=${changePublication}`,
      FIXTURE_WORKTREE: f.worktree,
    });
    f.writeLocal("prepare-push-result.env", receipt);
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
    expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
    const pending = f.pass("prepare-baseline-signing-request", requestArgs);
    const oid = /Awaiting signature: request=([a-f0-9]{40})/u.exec(pending.stdout)![1]!;
    const requestPath = f.local(`prepare-baseline-signing.${oid}.json`);
    const requestBytes = readFileSync(requestPath);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
    f.expectSnapshot(before);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    const duplicate = f.run("prepare-baseline-signing-request", requestArgs);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("Retained signing request exists");
    expect(readFileSync(requestPath)).toEqual(requestBytes);
  });
  it("rejects changed signatures, retained proof and current ownership", () => {
    const {
      f,
      source,
      baseline,
      credit,
      before,
      identity,
      request,
      signed,
      response,
      args,
      sign,
      requestPath,
      requestBytes,
    } = createSignedContext();
    const refuse = (message: string) => {
      const result = f.run("prepare-baseline-signing-continue", args);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
      expect(f.prepGit("rev-parse", "refs/heads/pr-42-prep")).toBe(source);
      expect(existsSync(f.local("review-transition.json"))).toBe(false);
      return result;
    };
    for (const [from, to] of [
      [source, baseline],
      ["fix: refresh", "fix: changed"],
      [credit, "Co-authored-by: Changed Example <changed@example.invalid>"],
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
    f.writeLocal("correction-review.json", before["correction-review.json"]!);
    const archive = JSON.parse(Buffer.from(request.binding, "base64").toString()).archive;
    for (const [name, bytes] of Object.entries(before)) {
      if (name !== "review.json") {
        expect(readFileSync(join(f.worktree, archive, name))).toEqual(bytes);
      }
    }
    const proof = join(f.worktree, archive, "correction-review.json");
    const proofBytes = readFileSync(proof);
    appendFileSync(proof, "\n");
    refuse("Retained successor proof changed");
    writeFileSync(proof, proofBytes);
    const addAbsentReceipt = f.local("add-absent-receipt.mjs");
    writeFileSync(
      addAbsentReceipt,
      `import fs from 'node:fs';
if (process.argv[1]?.endsWith('/baseline-refresh.mjs') && process.argv[2] === 'continue-signing') {
  const write = process.stdout.write;
  process.stdout.write = function(chunk, ...rest) {
    const result = write.call(this, chunk, ...rest);
    if (String(chunk).includes('"binding"')) {
      const archive = process.env.FIXTURE_ARCHIVE;
      fs.copyFileSync(archive + '/prepare-push-result.env', archive + '/prepare-sync-result.env');
    }
    return result;
  };
}
`,
    );
    const appeared = f.run("prepare-baseline-signing-continue", args, {
      NODE_OPTIONS: `--import=${addAbsentReceipt}`,
      FIXTURE_ARCHIVE: join(f.worktree, archive),
    });
    expect(appeared.status, appeared.stdout + appeared.stderr).not.toBe(0);
    expect(appeared.stdout + appeared.stderr).toContain("Signing evidence changed after replay");
    expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    rmSync(join(f.worktree, archive, "prepare-sync-result.env"));
    f.prepGit("switch", "-qc", "foreign-preparation");
    refuse("preparation branch changed");
    f.prepGit("switch", "-q", "pr-42-prep");
    mkdirSync(join(f.repo, ".local"), { recursive: true });
    writeFileSync(join(f.repo, ".local/live.json"), '{"state":"closed"}');
    refuse("PR identity changed");
    rmSync(join(f.repo, ".local/live.json"));
    f.git(f.repo, "update-ref", "refs/heads/topic", f.incoming, source);
    refuse("PR head changed before publication");
    f.git(f.repo, "update-ref", "refs/heads/topic", source, f.incoming);

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
    expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    // This fixture owns the deliberately corrupted ref; the real supervisor
    // must preserve it, and no fixture child remains after its joined return.
    expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toBe(baseline);
    f.git(f.repo, "update-ref", "-d", "refs/openclaw/pr-operation-locks/42", baseline);
  });
  it("recovers and republishes the same signed candidate", () => {
    const { f, source, baseline, before, signed, args, requestPath, requestBytes } =
      createSignedContext();
    const receipt = before["prepare-push-result.env"]!;
    const interrupted = f.run(
      "prepare-baseline-signing-continue",
      args,
      failRestore(f.root, f.env),
    );
    expect(interrupted.status, interrupted.stdout + interrupted.stderr).not.toBe(0);
    const journalBytes = f.readLocal("review-transition.json");
    expect(JSON.parse(journalBytes.toString()).target).toBe(signed.target);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
    expect(readFileSync(requestPath)).toEqual(requestBytes);
    // Older interrupted installations retired this still-current hosted receipt.
    rmSync(f.local("prepare-push-result.env"));
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.readLocal("prepare-push-result.env")).toEqual(receipt);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(signed.target);
    expect(f.prepGit("show", "-s", "--format=%P", "HEAD")).toBe(`${source} ${baseline}`);
    f.prepGit("verify-commit", "HEAD");
    expect(f.readLocal("review.json")).toEqual(before["review.json"]);
    f.expectAbsent("review-transition.json", "correction-review.json");
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(signed.target);
    f.git(f.repo, "config", "user.signingKey", f.key);
    f.approve();
    f.publish();
  });
});
