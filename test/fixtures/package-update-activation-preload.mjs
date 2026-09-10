import childProcess from "node:child_process";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const encoded = process.env.OPENCLAW_ACTIVATION_TEST_FAULTS;
const faults = encoded ? JSON.parse(encoded) : [];
const write = fs.writeSync.bind(fs);
let cursor = 0;
let occurrences = 0;

if (process.env.OPENCLAW_ACTIVATION_TEST_OBSERVE_CHILDREN === "1") {
  const spawn = childProcess.spawn.bind(childProcess);
  const liveRoot = process.env.OPENCLAW_ACTIVATION_TEST_LIVE_ROOT;
  const roleFor = (args, env, cwd = process.cwd()) => {
    if (
      !liveRoot ||
      !Array.isArray(args) ||
      typeof args[0] !== "string" ||
      args.some((arg) => ["--check", "--help", "-h"].includes(arg))
    ) {
      return undefined;
    }
    const entry = path.resolve(cwd, args[0]);
    if (entry === path.join(liveRoot, "dist", "infra", "update-migrated-finalize.worker.js")) {
      return "candidate-migrated-finalizer";
    }
    // Rehearsals use staged package roots; only the installed entrypoints count.
    if (
      !["openclaw.mjs", "dist/index.js", "dist/index.mjs"].some(
        (relative) => entry === path.join(liveRoot, relative),
      )
    ) {
      return undefined;
    }
    if (args[1] === "doctor") {
      // Readiness parses stdout as JSON and is not a repair-Doctor pass.
      if (args.includes("--lint") && args.includes("--json")) return undefined;
      return env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === "1"
        ? "post-plugin-doctor"
        : "active-doctor";
    }
    if (args[1] === "update") {
      return env.OPENCLAW_UPDATE_POST_CORE === "1" ? "candidate-post-core" : "published-updater";
    }
    return undefined;
  };
  const installedIdentity = () => ({
    packageVersion: JSON.parse(fs.readFileSync(path.join(liveRoot, "package.json"), "utf8"))
      .version,
    codeSha: JSON.parse(fs.readFileSync(path.join(liveRoot, "dist", "build-info.json"), "utf8"))
      .commit,
  });
  const startIdentity = (pid) => {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(
        stat
          .slice(stat.lastIndexOf(")") + 1)
          .trimStart()
          .split(/\s+/u)[19],
      );
    }
    const result = childProcess.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    if (result.status !== 0) throw new Error("fixture child identity could not be captured");
    return Math.floor(Date.parse(`${result.stdout.trim()} UTC`) / 1000);
  };
  let observations = 0;
  const emit = (event) => {
    if (liveRoot && ++observations > 128) {
      // Dropped child observations make custody uncertain; the harness retains
      // its fixture on this marker instead of accepting a partial process trace.
      if (observations === 129) {
        write(1, 'OPENCLAW_ACTIVATION_TEST {"event":"observation-overflow"}\n');
      }
      return;
    }
    write(1, `OPENCLAW_ACTIVATION_TEST ${JSON.stringify(event)}\n`);
  };
  const ownRole = roleFor(process.argv.slice(1), process.env);
  const ownStartIdentity = ownRole ? startIdentity(process.pid) : undefined;
  if (ownRole && ownRole !== "active-doctor") {
    emit({
      event: "started",
      role: ownRole,
      pid: process.pid,
      parentPid: process.ppid,
      startIdentity: ownStartIdentity,
      ...installedIdentity(),
    });
  }
  childProcess.spawn = (command, args, options) => {
    const env = options?.env ?? process.env;
    const role = roleFor(args, env, options?.cwd);
    if (liveRoot ? !role : env.OPENCLAW_UPDATE_POST_CORE !== "1") {
      return spawn(command, args, options);
    }
    const observedIdentity = role ? installedIdentity() : undefined;
    const fd3 = Array.isArray(options?.stdio) && options.stdio[3] === "pipe";
    const fault = fd3 ? process.env.OPENCLAW_ACTIVATION_TEST_CHILD_FAULT : undefined;
    const child = spawn(
      fault === "spawn" ? path.join(env.TMPDIR, "missing-activation-node") : command,
      args,
      options,
    );
    if (child.pid) {
      emit({
        event: "spawned",
        pid: child.pid,
        parentPid: process.pid,
        startIdentity: startIdentity(child.pid),
        detached: options?.detached === true,
        fd3,
        ...(role ? { role, parentStartIdentity: ownStartIdentity, ...observedIdentity } : {}),
      });
      child.once("exit", (code, signal) => emit({ event: "reaped", pid: child.pid, code, signal }));
      if (fault === "early-exit") process.kill(child.pid, "SIGKILL");
      if (fault === "closed-pipe") child.stdio[3].destroy();
    }
    return child;
  };
}

if (process.env.OPENCLAW_ACTIVATION_TEST_ISOLATE_TMP === "1") {
  const lstatSync = fs.lstatSync.bind(fs);
  // Exercise the existing private TMPDIR fallback without inspecting, repairing,
  // or writing the operator's preferred shared coordinator directory.
  fs.lstatSync = (value, ...args) => {
    if (path.resolve(String(value)) === "/tmp/openclaw") {
      throw Object.assign(new Error("fixture denies the shared temporary root"), {
        code: "EACCES",
      });
    }
    return lstatSync(value, ...args);
  };
}

function pathname(value) {
  return path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
}

function checkpoint(operation, method, args, when) {
  const fault = faults[cursor];
  if (
    !fault ||
    (fault.operation !== operation && fault.operation !== method) ||
    fault.when !== when
  ) {
    return;
  }
  if (fault.postCore && process.env.OPENCLAW_UPDATE_POST_CORE !== "1") return;
  const selected = pathname(args[fault.argument ?? 0]);
  const expected = pathname(fault.path);
  if (
    selected !== expected &&
    !(fault.descendants && selected.startsWith(`${expected}${path.sep}`))
  ) {
    return;
  }
  if (fault.basename && path.basename(selected) !== fault.basename) return;
  occurrences++;
  if (occurrences !== (fault.occurrence ?? 1)) {
    return;
  }
  cursor++;
  occurrences = 0;
  write(
    1,
    `OPENCLAW_ACTIVATION_TEST ${JSON.stringify({
      event: "checkpoint",
      pid: process.pid,
      label: fault.label,
      operation: method,
      when,
      path: selected,
    })}\n`,
  );
  if (fault.action === "error") {
    throw Object.assign(new Error(`activation fixture: ${fault.label}`), { code: "EIO" });
  }
  if (fault.action === "observe") return;
  // The real operation has already happened for "after" checkpoints. Park before
  // its acknowledgement; only the test owner may kill this exact child.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

for (const [operation, names] of [
  ["rename", ["rename"]],
  ["remove", ["unlink", "rmdir", "rm"]],
  ["copy", ["copyFile"]],
  ["symlink", ["symlink"]],
]) {
  for (const name of names) {
    const originalAsync = promises[name].bind(promises);
    promises[name] = async (...args) => {
      checkpoint(operation, name, args, "before");
      const result = await originalAsync(...args);
      checkpoint(operation, name, args, "after");
      return result;
    };
    const syncName = `${name}Sync`;
    const originalSync = fs[syncName].bind(fs);
    fs[syncName] = (...args) => {
      checkpoint(operation, syncName, args, "before");
      const result = originalSync(...args);
      checkpoint(operation, syncName, args, "after");
      return result;
    };
  }
}

// fs-safe consumes both default and named builtin imports. Install the wrappers
// before loading its guarded operations, including the standalone sealed helper.
syncBuiltinESMExports();
