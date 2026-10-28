import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createCorrectionFixture } from "./pr-correction-preparation.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const scripts = join(process.cwd(), "scripts");
const describePosix = process.platform === "win32" ? describe.skip : describe;
let root: string;
let scratch: string;
let probe: string;
let git: string;
let node: string;
let head: string;
let env: NodeJS.ProcessEnv;
const authorityPath = ".local/correction-review.json";
const oid = (bytes: Buffer) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const expectClean = () =>
  expect(readdirSync(scratch).filter((name) => name.startsWith("openclaw-pr-hash-"))).toEqual([]);

function invocation(bytes: Buffer) {
  writeFileSync(join(root, authorityPath), bytes);
  const script = join(scripts, "pr-lib/baseline-refresh.mjs");
  return {
    args: [script, "check-source", "42", head, root, root, "invalid-lock", head],
    input: `${authorityPath} ${oid(bytes)}\n`,
  };
}

// Exercise the real check-source CLI, stopping at its next mandatory owner guard.
// No fixture pretends that hashing alone grants transition authority.
function run(bytes: Buffer, overrides: NodeJS.ProcessEnv = {}, limitedWrite = false) {
  const { args, input } = invocation(bytes);
  const limitedArgs = [
    "-c",
    "import os,resource,signal,sys; signal.signal(signal.SIGXFSZ,signal.SIG_IGN); resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024)); os.execv(sys.argv[1],sys.argv[1:])",
    node,
    ...args,
  ];
  const result = spawnSync(limitedWrite ? "python3" : node, limitedWrite ? limitedArgs : args, {
    cwd: root,
    env: { ...env, ...overrides },
    input,
    encoding: "utf8",
  });
  expectClean();
  return result;
}

describePosix("captured baseline hash stdin", () => {
  beforeAll(() => {
    const fixture = createCorrectionFixture(dirs.make("pr-hash-"));
    root = fixture.root;
    head = fixture.incoming;
    scratch = join(root, ".local/tmp");
    mkdirSync(scratch, { recursive: true });
    git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    node = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
    env = { ...fixture.env, TMPDIR: scratch };
    probe = join(root, ".local/git-probe");
    writeFileSync(
      probe,
      `#!/usr/bin/env python3
import os,sys,stat,fcntl
args=sys.argv[1:]
if args == ['hash-object','--no-filters','--stdin']:
 s=os.fstat(0)
 assert stat.S_ISREG(s.st_mode), 'snapshot stdin must be a regular file'
 assert s.st_nlink == 0, 'snapshot pathname still linked'
 assert stat.S_IMODE(s.st_mode) == 0o600, 'snapshot is not private'
 assert fcntl.fcntl(0,fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY, 'snapshot is writable'
 assert os.lseek(0,0,os.SEEK_CUR) == 0, 'snapshot offset is not zero'
 assert not any(n.startswith('openclaw-pr-hash-') for n in os.listdir(os.environ['TMPDIR'])), 'snapshot directory retained at dispatch'
 if os.environ.get('MUTATE_ORIGINAL'): open('${authorityPath}','wb').write(b'changed after capture')
 if os.environ.get('FAIL_HASH'): sys.stderr.write('fixture Git hash failure\\n'); sys.exit(97)
os.execv(${JSON.stringify(git)},[${JSON.stringify(git)},*args])
`,
    );
    chmodSync(probe, 0o700);
    env.OPENCLAW_PR_GIT = probe;
  });

  it("hashes exact empty, invalid UTF-8, newline-sensitive and large captured bytes", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from([0, 255, 254, 128, 10]),
      Buffer.from("x"),
      Buffer.from("x\n"),
      Buffer.from("x\r\n\n"),
      Buffer.alloc(32 * 1024 * 1024, 0xa5),
    ]) {
      const result = run(bytes);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing baseline transition operation owner.");
    }
  });

  it("does not reread the original authority pathname after capture", () => {
    const result = run(Buffer.from("original\n"), { MUTATE_ORIGINAL: "1" });
    expect(result.stderr).toContain("Missing baseline transition operation owner.");
    expect(readFileSync(join(root, authorityPath), "utf8")).toBe("changed after capture");
  });

  it("fails closed and cleans its resources on write, spawn and Git failures", () => {
    for (const [result, message] of [
      [run(Buffer.alloc(4096), {}, true), "EFBIG"],
      [run(Buffer.from("spawn"), { OPENCLAW_PR_GIT: join(root, "missing-git") }), "ENOENT"],
      [run(Buffer.from("git"), { FAIL_HASH: "1" }), "fixture Git hash failure"],
    ] as const) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });
});
