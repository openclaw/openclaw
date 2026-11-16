import { spawnSync } from "node:child_process";
import { closeSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const preload = resolve("scripts/pr-lib/dependency-lifetime-inherit.cjs");
const bun = process.env.OPENCLAW_BUN_PATH || (process.versions.bun ? process.execPath : undefined);
const runtimes = [
  { runtime: "node", executable: requireNodeTool("node") },
  ...(bun ? [{ runtime: "bun", executable: bun }] : []),
];

function fixture(node: string) {
  const root = realpathSync(tempDirs.make("pr-lifetime-inheritance-"));
  const lifetime = join(root, "lifetime");
  writeFileSync(lifetime, "", { mode: 0o600 });
  return { root, lifetime, node };
}

describePosix("PR dependency lifetime inheritance", () => {
  it("carries primary and ancestor lifetimes through the Python Git owner to Git helpers", () => {
    const f = fixture(requireNodeTool("node"));
    const inner = join(f.root, "inner-lifetime");
    const reader = join(f.root, "reader.cjs");
    const policy = join(f.root, "policy.py");
    writeFileSync(inner, "", { mode: 0o600 });
    writeFileSync(
      reader,
      `const assert = require("node:assert/strict");
assert.equal(process.env.OPENCLAW_PR_LIFETIME_FILE, ${JSON.stringify(inner)});
assert(JSON.parse(process.env.OPENCLAW_PR_LIFETIME_ANCESTORS).some(item => item.path === ${JSON.stringify(f.lifetime)}));
console.log("Git helper retained both lifetimes");
`,
    );
    writeFileSync(
      policy,
      `from ci_git_owner import run_git
import shlex
run_git(${JSON.stringify(f.root)}, "-c", "alias.lifetime=!" + shlex.join([${JSON.stringify(f.node)}, ${JSON.stringify(reader)}]), "lifetime")
`,
    );
    const fd = openSync(f.lifetime, "r+");
    try {
      const result = spawnSync(
        f.node,
        [
          "-e",
          `const { openSync, closeSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const fd = openSync(${JSON.stringify(inner)}, "r+");
try {
  const result = spawnSync("python3", ["-I", "-S", ${JSON.stringify(resolve(".github/actions/git-owner/owner.py"))}, "--policy", ${JSON.stringify(policy)}], {
    env: { ...process.env, OPENCLAW_PR_LIFETIME_FILE: ${JSON.stringify(inner)} },
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", fd], encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally { closeSync(fd); }
`,
        ],
        {
          env: {
            ...process.env,
            HOME: f.root,
            OPENCLAW_PR_LIFETIME_FILE: f.lifetime,
            NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
          },
          stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", fd],
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Git helper retained both lifetimes");
    } finally {
      closeSync(fd);
    }
  });

  it.each(runtimes)(
    "preserves the lifetime through $runtime launches, custom environments and fork IPC",
    ({ executable }) => {
      const f = fixture(executable);
      const reader = join(f.root, "reader.cjs");
      writeFileSync(
        reader,
        `const fs = require("node:fs");
const held = fs.fstatSync(7), named = fs.statSync(process.env.OPENCLAW_PR_LIFETIME_FILE);
const result = { held: held.dev === named.dev && held.ino === named.ino, value: process.env.VALUE };
if (process.send) process.send(result); else console.log(JSON.stringify(result));
`,
      );
      const fd = openSync(f.lifetime, "r+");
      try {
        const result = spawnSync(
          f.node,
          [
            "--input-type=module",
            "-e",
            `import assert from "node:assert/strict";
import * as cp from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
const reader = process.argv[1], node = process.execPath;
const options = { env: { VALUE: "kept" }, encoding: "utf8" };
const command = JSON.stringify(node) + " " + JSON.stringify(reader);
assert.throws(() => cp.spawn(node, [reader], { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "pipe"] }), /FD7 conflicts/);
const results = [];
results.push(JSON.parse(cp.spawnSync(node, [reader], options).stdout));
results.push(JSON.parse(cp.execFileSync(node, [reader], options)));
results.push(JSON.parse(cp.execSync(command, options)));
for (const name of ["exec", "execFile"]) {
  const args = name === "exec" ? [command, options] : [node, [reader], options];
  results.push(JSON.parse((await promisify(cp[name])(...args)).stdout));
}
const spawned = cp.spawn(node, [reader], options);
let output = "";
spawned.stdout.on("data", chunk => output += chunk);
await once(spawned, "close");
results.push(JSON.parse(output));
const forked = cp.fork(reader, undefined, { ...options, execArgv: [], silent: true });
const message = once(forked, "message"), closed = once(forked, "close");
results.push((await message)[0]);
await closed;
console.log(JSON.stringify(results));`,
            reader,
          ],
          {
            env: {
              ...process.env,
              HOME: f.root,
              OPENCLAW_PR_LIFETIME_FILE: f.lifetime,
              NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
            },
            stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", fd],
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(
          Array.from({ length: 7 }, () => ({ held: true, value: "kept" })),
        );
      } finally {
        closeSync(fd);
      }
    },
  );

  it.each(runtimes)(
    "keeps both lifetime flocks while a lazy $runtime grandchild survives both killed creators",
    ({ executable }) => {
      const f = fixture(executable);
      const packagePath = join(f.root, "package.txt");
      writeFileSync(packagePath, "still readable");
      const parent = join(f.root, "parent.cjs");
      const outer = join(f.root, "outer-lifetime");
      const outerParent = join(f.root, "outer.cjs");
      writeFileSync(outer, "", { mode: 0o600 });
      writeFileSync(
        outerParent,
        `const { spawn } = require("node:child_process");
const env = { ...process.env };
if (process.env.PROTECT_INNER === "yes") env.OPENCLAW_PR_LIFETIME_FILE = process.env.INNER;
else { delete env.OPENCLAW_PR_LIFETIME_FILE; env.HOME += "/independent"; }
const child = spawn(process.execPath, [process.env.PARENT], {
  env, stdio: ["ignore", 1, 2, Number(process.env.CONTROL_FD), Number(process.env.EXIT_FD), "ignore", "ignore", 8],
});
console.log("parent " + child.pid);
setInterval(() => {}, 1000);
`,
      );
      writeFileSync(
        parent,
        `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(`
const { readSync, readFileSync } = require("node:fs");
console.log("ready " + process.pid);
const command = Buffer.alloc(1);
while (readSync(3, command, 0, 1, null)) {
  if (command[0] === 113) break;
  console.log(readFileSync(process.env.PACKAGE, "utf8"));
}
`)}], {
  detached: true,
  env: { PACKAGE: process.env.PACKAGE },
  stdio: ["ignore", 1, 2, Number(process.env.CONTROL_FD)]
});
setInterval(() => {}, 1000);
`,
      );
      const run = (inherit: boolean) =>
        spawnSync(
          "python3",
          [
            "-c",
            `import fcntl, json, os, signal, subprocess, sys
node, preload, lifetime, outer, parent, outer_parent, package, protect_inner = sys.argv[1:]
ancestors = tuple(item["fd"] for item in json.loads(os.environ.get("OPENCLAW_PR_LIFETIME_ANCESTORS", "[]")))
for path, target in ((outer,7),(lifetime,8)):
    fd = os.open(path, os.O_RDWR)
    os.dup2(fd, target)
    if fd != target: os.close(fd)
    fcntl.flock(target, fcntl.LOCK_SH)
read_fd, write_fd = os.pipe()
exit_read, exit_write = os.pipe()
env = dict(os.environ, OPENCLAW_PR_LIFETIME_FILE=outer, INNER=lifetime, PARENT=parent,
    NODE_OPTIONS="--require " + json.dumps(preload), PACKAGE=package, CONTROL_FD=str(read_fd), EXIT_FD=str(exit_write), PROTECT_INNER=protect_inner)
child = subprocess.Popen([node, outer_parent], env=env, pass_fds=(7,8,read_fd,exit_write,*ancestors), stdout=subprocess.PIPE, text=True)
os.close(7)
os.close(8)
os.close(read_fd)
os.close(exit_write)
reader = None
inner_parent = None
try:
    parent_ready = child.stdout.readline().strip()
    assert parent_ready.startswith("parent "), parent_ready
    inner_parent = int(parent_ready.split()[1])
    ready = child.stdout.readline().strip()
    assert ready.startswith("ready "), ready
    reader = int(ready.split()[1])
    child.kill()
    child.wait()
    os.kill(inner_parent, signal.SIGKILL)
    inner_parent = None
    assert os.read(exit_read, 1) == b"", "Inner creator still owns its descriptors"
    with open(outer, "r+") as outer_exclusive, open(lifetime, "r+") as exclusive:
        for label, handle in (("outer",outer_exclusive),("inner",exclusive)):
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError("Live child lost the " + label + " lifetime flock")
            except BlockingIOError:
                pass
        os.write(write_fd, b"r")
        assert child.stdout.readline().strip() == "still readable"
        os.write(write_fd, b"q")
        fcntl.flock(exclusive, fcntl.LOCK_EX)
        fcntl.flock(outer_exclusive, fcntl.LOCK_EX)
    print("protected-until-last-holder-exited")
finally:
    os.close(write_fd)
    os.close(exit_read)
    if child.poll() is None:
        child.kill()
    child.wait()
    for pid in (reader,inner_parent):
        if pid:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
`,
            f.node,
            preload,
            f.lifetime,
            outer,
            parent,
            outerParent,
            packagePath,
            inherit ? "yes" : "no",
          ],
          { env: { ...process.env, HOME: f.root }, encoding: "utf8", timeout: 15_000 },
        );
      const before = run(false);
      expect(before.status).toBe(1);
      expect(before.stderr).toContain("Live child lost the inner lifetime flock");
      const result = run(true);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("protected-until-last-holder-exited");
    },
  );
});
