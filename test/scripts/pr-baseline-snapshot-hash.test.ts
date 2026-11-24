import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createCapturedHashProbe,
  createCorrectionFixture,
} from "./pr-correction-preparation.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const scripts = join(process.cwd(), "scripts");
const describePosix = process.platform === "win32" ? describe.skip : describe;
let root: string;
let scratch: string;
let node: string;
let head: string;
let env: NodeJS.ProcessEnv;
let calls: string;
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
function run(
  bytes: Buffer,
  overrides: NodeJS.ProcessEnv = {},
  limitedWrite = false,
  snapshot?: string,
) {
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
    input: snapshot ?? input,
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
    const probe = createCapturedHashProbe(root);
    scratch = probe.scratch;
    calls = probe.calls;
    node = requireNodeTool("node");
    env = { ...fixture.env, ...probe.env };
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

  function sequence(inputs: [number, number][], overrides: NodeJS.ProcessEnv = {}) {
    const bytes = inputs.map(([size, identity]) => {
      const value = Buffer.alloc(size, identity % 256);
      value.writeUInt32LE(identity);
      return value;
    });
    const path = join(root, ".local/hash-sequence.json");
    writeFileSync(path, JSON.stringify(inputs));
    writeFileSync(calls, "");
    const result = run(
      bytes[0]!,
      { HASH_SEQUENCE: path, ...overrides },
      false,
      bytes.map((value) => `${authorityPath} ${oid(value)}\n`).join(""),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing baseline transition operation owner.");
    return readFileSync(calls, "utf8").trim().split("\n").length;
  }

  it("reuses identical captured bytes while rereading changed authority", () => {
    expect(
      sequence([
        [8, 1],
        [8, 2],
        [8, 1],
      ]),
    ).toBe(2);
  });

  it("requires exact bytes even when the lookup digest collides", () => {
    const preload = join(root, ".local/hash-index-collision.mjs");
    writeFileSync(
      preload,
      `
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const original = crypto.createHash;
crypto.createHash = function(algorithm, ...args) {
  if (algorithm !== 'sha256') return original(algorithm, ...args);
  return { update() { return this; }, digest() { return '0'.repeat(64); } };
};
syncBuiltinESMExports();
`,
    );
    expect(
      sequence(
        [
          [8, 1],
          [8, 2],
          [8, 1],
        ],
        { NODE_OPTIONS: `--import=${preload}` },
      ),
    ).toBe(2);
  });

  it.each([
    { name: "entry", count: 1025, size: 8 },
    { name: "byte", count: 9, size: 1024 * 1024 },
  ])("keeps validating after the $name retention limit", ({ count, size }) => {
    const inputs: [number, number][] = Array.from({ length: count }, (_, index) => [size, index]);
    expect(sequence([...inputs, inputs.at(-1)!, inputs[0]!])).toBe(count + 1);
  });

  it("hashes large captured inputs without writing a temporary snapshot", () => {
    const result = run(Buffer.alloc(32 * 1024 * 1024, 0xa5), {}, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing baseline transition operation owner.");
  });

  it("fails closed and cleans its resources on spawn and Git failures", () => {
    for (const [result, message] of [
      [run(Buffer.from("spawn"), { OPENCLAW_PR_GIT: join(root, "missing-git") }), "ENOENT"],
      [run(Buffer.from("git"), { FAIL_HASH: "1" }), "fixture Git hash failure"],
    ] as const) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });
});
