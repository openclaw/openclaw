/** Keep fake GitHub responses in the requesting Node helper; real Git stays native. */
export function createMergeGhFixturePrograms(body: string) {
  return {
    cli: String.raw`
"use strict";
const nativeFs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { format } = require("node:util");
const hostProcess = process;
module.exports = function runGh(route, args, options = {}) {
  let stdout = "", stderr = "", status = 0;
  const stopped = {};
  const process = {
    env: options.env ?? hostProcess.env,
    execArgv: hostProcess.execArgv,
    kill: (pid, signal) => hostProcess.kill(pid, signal),
    stdout: { write: (value) => { stdout += value; return true; } },
    stderr: { write: (value) => { stderr += value; return true; } },
    exit(code = 0) { status = code; throw stopped; },
  };
  const console = {
    log: (...values) => { stdout += format(...values) + "\n"; },
    error: (...values) => { stderr += format(...values) + "\n"; },
  };
  const fs = {
    ...nativeFs,
    readFileSync(file, encoding) {
      if (file !== 0 || options.input === undefined) return nativeFs.readFileSync(file, encoding);
      const bytes = Buffer.from(options.input);
      const selected = typeof encoding === "string" ? encoding : encoding?.encoding;
      return selected ? bytes.toString(selected) : bytes;
    },
  };
  try {
${body}
  } catch (error) {
    if (error !== stopped) { status = 1; stderr += String(error?.stack ?? error) + "\n"; }
  }
  return { status, stdout, stderr };
};
if (require.main === module) {
  const [route, ...args] = process.argv.slice(2);
  const result = module.exports(route, args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
`,
    preload: String.raw`
"use strict";
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { execFileSync: nativeExecFileSync, spawn: nativeSpawn, spawnSync: nativeSpawnSync } = childProcess;
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
function resolvesToFixture(file, args, options) {
  if (typeof file !== "string" || !Array.isArray(args) ||
      options.timeout !== undefined || options.signal !== undefined ||
      (options.cwd !== undefined && path.resolve(options.cwd) !== process.cwd())) return false;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (file.includes("/")) return path.resolve(cwd, file) === env.FIXTURE_GH_BIN;
  if (file !== "gh") return false;
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.resolve(cwd, directory, file);
    try { fs.accessSync(candidate, fs.constants.X_OK); } catch { continue; }
    return candidate === env.FIXTURE_GH_BIN;
  }
  return false;
}
function runFixture(args, options, input) {
  const env = options.env ?? process.env;
  return require(env.FIXTURE_GH)("direct", args, { env, input });
}
childProcess.execFileSync = function(file, args, options = {}) {
  // Other child boundaries, working directories and stream shapes remain native.
  if (typeof options !== "object" || !resolvesToFixture(file, args, options) ||
      (options.stdio !== undefined && (!Array.isArray(options.stdio) ||
        options.stdio[1] !== "pipe" || options.stdio[2] !== "pipe"))) return nativeExecFileSync(file, args, options);
  const stdin = options.stdio?.[0];
  if (stdin !== undefined && !["pipe", "ignore", "inherit", 0].includes(stdin)) {
    return nativeExecFileSync(file, args, options);
  }
  const result = runFixture(args, options,
    options.input ?? (stdin === "inherit" || stdin === 0 ? undefined : Buffer.alloc(0)));
  const encode = (value) => options.encoding && options.encoding !== "buffer"
    ? Buffer.from(value).toString(options.encoding) : Buffer.from(value);
  const stdout = encode(result.stdout), stderr = encode(result.stderr);
  if (result.status !== 0) {
    throw Object.assign(new Error("Command failed: " + file + "\n" + result.stderr), {
      status: result.status, signal: null, stdout, stderr, output: [null, stdout, stderr],
    });
  }
  return stdout;
};
// Real live-cwd ownership is covered by pr-worktree-evidence.test.ts; merge fixtures are quiescent.
childProcess.spawnSync = function(file, args, options = {}) {
  if (file === "lsof" && JSON.stringify(args) === '["-nP","-d","cwd","-Fpn0"]' && options.encoding === "utf8") {
    return { status: 0, signal: null, stdout: "p" + process.pid + "\0n" + process.cwd() + "\0", stderr: "" };
  }
  return nativeSpawnSync(file, args, options);
};
childProcess.spawn = function(file, args, options = {}) {
  if (!resolvesToFixture(file, args, options)) return nativeSpawn(file, args, options);
  const child = new EventEmitter();
  for (const stream of ["stdout", "stderr", "stdin"]) child[stream] = new PassThrough();
  child.kill = () => false;
  // Microtasks serialize requests against the fixture's single JSON state.
  queueMicrotask(() => {
    const result = runFixture(args, options, Buffer.alloc(0));
    for (const stream of ["stdout", "stderr"]) child[stream].end(result[stream]);
    child.emit("close", result.status, null);
  });
  return child;
};
syncBuiltinESMExports();
`,
  };
}
