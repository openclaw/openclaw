import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_PREFIX,
  collectUnusedDependencyCaches,
  withDependencyCacheLock,
} from "../../scripts/pr-lib/cache-lifetime.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  anchoredStdio,
  createIndependentPrFixtureEnv,
  createSettledPrCacheEntry,
  prCacheEntries,
  readPrCacheState,
  runWithPrAnchor,
} from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const source = pathToFileURL(resolve("scripts/pr-lib/cache-lifetime.mjs")).href;
const processHelper = resolve("scripts/pr-lib/cache-lifetime-process.py");

function fixture() {
  const home = realpathSync(tempDirs.make("pr-cache-collection-"));
  const cache = join(home, ".cache/openclaw/pr-dependencies/v3");
  withDependencyCacheLock(cache, () => {});
  const node = requireNodeTool("node");
  const creatorPid = spawnSync(node, ["-e", ""]).pid;
  const anchor = join(home, `${ANCHOR_PREFIX}${creatorPid}.fixture`);
  mkdirSync(anchor, { mode: 0o700 });
  const env = { ...createIndependentPrFixtureEnv(), HOME: home };
  return { home, cache, node, anchor, creatorPid, env };
}

function child(f: ReturnType<typeof fixture>, body: string, leased = false) {
  const args = [
    "--input-type=module",
    "-e",
    `
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { claimCreatedAnchor, holdDependencyCache, publishDependencyCache, stageDependencyCache, retireAnchorDependencies, collectUnusedDependencyCaches, withDependencyCacheLock } from ${JSON.stringify(source)};
const anchor = claimCreatedAnchor(process.argv[1], Number(process.argv[2]));
const cache = process.argv[3], entry = cache + "/" + "a".repeat(64);
${body}`,
    f.anchor,
    String(f.creatorPid),
    f.cache,
  ];
  if (!leased) {
    return runWithPrAnchor(f.anchor, args, { env: f.env });
  }
  const created = runWithPrAnchor(
    f.anchor,
    [
      resolve("scripts/pr-lib/cache-lifetime.mjs"),
      "create-lifetime",
      f.anchor,
      String(f.creatorPid),
    ],
    { env: f.env },
  );
  expect(created.status, created.stderr).toBe(0);
  const lease = created.stdout;
  const fd = openSync(lease, "r+");
  const anchorFd = openSync(f.anchor, "r");
  const stdio = anchoredStdio(anchorFd);
  stdio[7] = fd;
  try {
    const shared = spawnSync("python3", ["-I", "-S", "-B", processHelper, "shared", "7"], {
      stdio,
      encoding: "utf8",
    });
    expect(shared.status, shared.stderr).toBe(0);
    const registered = spawnSync(
      f.node,
      [
        resolve("scripts/pr-lib/cache-lifetime.mjs"),
        "register-lifetime",
        f.anchor,
        String(f.creatorPid),
      ],
      {
        env: { ...f.env, OPENCLAW_PR_LIFETIME_FILE: lease },
        stdio,
        encoding: "utf8",
      },
    );
    expect(registered.status, registered.stderr).toBe(0);
    return spawnSync(f.node, args, {
      env: { ...f.env, OPENCLAW_PR_LIFETIME_FILE: lease },
      stdio,
      encoding: "utf8",
    });
  } finally {
    closeSync(anchorFd);
    closeSync(fd);
  }
}

function sweep(cache: string) {
  for (const path of withDependencyCacheLock(cache, (lock) =>
    collectUnusedDependencyCaches(lock),
  )) {
    rmSync(path, { recursive: true });
  }
}

function completeProcessCensus(f: ReturnType<typeof fixture>) {
  if (process.platform !== "linux") {
    return true;
  }
  const probe = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `
import importlib.util,sys
spec = importlib.util.spec_from_file_location("owner", sys.argv[1])
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
try:
    owner.process_scan({sys.argv[2]})
except (PermissionError, ValueError) as error:
    if not isinstance(error, PermissionError) and str(error) != "zombie-group-has-threads":
        raise
    print(str(error))
    sys.exit(3)
`,
      processHelper,
      f.anchor,
    ],
    { env: f.env, encoding: "utf8", timeout: 30_000 },
  );
  expect([0, 3], probe.stderr).toContain(probe.status);
  if (probe.status === 3) {
    console.info(`Restricted procfs; asserting retained cache state: ${probe.stdout.trim()}`);
  }
  return probe.status === 0;
}

function transitions(cache: string) {
  const db = new DatabaseSync(join(cache, "lifetime.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT path, entry_key, kind FROM dependency_transitions ORDER BY path")
      .all();
  } finally {
    db.close();
  }
}

describePosix("PR cache crash collection", () => {
  it("keeps a shared operation lease until every nested anchor is collected", () => {
    const f = fixture();
    const result = child(
      f,
      `
import { spawnSync } from "node:child_process";
const stage = withDependencyCacheLock(cache, lock => stageDependencyCache(lock, entry, anchor));
withDependencyCacheLock(cache, lock => publishDependencyCache(lock, stage, entry, anchor));
for (let index = 1; index < 5; index++) {
  const nested = anchor.path + index;
  fs.mkdirSync(nested, { mode: 0o700 });
  const fd = fs.openSync(nested, "r");
  try {
    const held = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`
import { claimCreatedAnchor, holdDependencyCache, withDependencyCacheLock } from ${JSON.stringify(source)};
const anchor = claimCreatedAnchor(process.argv[1], Number(process.argv[2]));
if (!withDependencyCacheLock(process.argv[3], lock => holdDependencyCache(lock, process.argv[4], anchor))) throw new Error("Nested hold missing");
`)}, nested, process.argv[2], cache, entry], {
      env: process.env, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", 7, "ignore", fd],
    });
    if (held.status !== 0) throw new Error(held.stderr);
  } finally { fs.closeSync(fd); }
}
withDependencyCacheLock(cache, lock => collectUnusedDependencyCaches(lock));
`,
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    const entry = join(f.cache, "a".repeat(64));
    expect(readPrCacheState(entry).anchors).toHaveLength(5);
    sweep(f.cache);
    expect(readPrCacheState(entry).anchors).toHaveLength(1);
    expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toHaveLength(1);
    sweep(f.cache);
    expect(readPrCacheState(entry)).toEqual({ registered: true, settled: true, anchors: [] });
    expect(readdirSync(f.home).filter((name) => name.startsWith(ANCHOR_PREFIX))).toEqual([]);
    expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toEqual([]);
    const db = new DatabaseSync(join(f.cache, "lifetime.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM operation_lifetimes").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM pending_lifetimes").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(["intent", "file", "ready"])(
    "collects or safely retains an operation interrupted after lifetime %s",
    (phase) => {
      const f = fixture();
      const result =
        phase === "ready"
          ? child(f, "", true)
          : runWithPrAnchor(
              f.anchor,
              [
                "--input-type=module",
                "-e",
                `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync;
fs.openSync = function(path, ...args) {
  if (String(path).split("/").at(-1).startsWith("lifetime-")) {
    if (${JSON.stringify(phase)} === "file") open.call(this, path, ...args);
    process.kill(process.pid, "SIGKILL");
  }
  return open.call(this, path, ...args);
};
syncBuiltinESMExports();
process.argv = [process.execPath, process.argv[1], "create-lifetime", process.argv[2], process.argv[3]];
await import(${JSON.stringify(source)});
`,
                resolve("scripts/pr-lib/cache-lifetime.mjs"),
                f.anchor,
                String(f.creatorPid),
              ],
              { env: f.env },
            );
      if (phase === "ready") {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.signal, result.stderr).toBe("SIGKILL");
      }
      expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toHaveLength(
        phase === "intent" ? 0 : 1,
      );
      const complete = phase === "ready" || completeProcessCensus(f);
      sweep(f.cache);
      expect(existsSync(f.anchor)).toBe(!complete);
      expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toHaveLength(
        !complete && phase === "file" ? 1 : 0,
      );
      const db = new DatabaseSync(join(f.cache, "lifetime.sqlite"), { readOnly: true });
      try {
        expect(db.prepare("SELECT * FROM pending_lifetimes").all()).toHaveLength(complete ? 0 : 1);
        expect(db.prepare("SELECT * FROM operation_lifetimes").all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it.each(["hold", "zero-hold"])(
    "protects a lazy %s reader after its creator is killed until the last child exits",
    (phase) => {
      const f = fixture();
      const parent = join(f.home, "creator.mjs");
      writeFileSync(
        parent,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { claimCreatedAnchor, stageDependencyCache, publishDependencyCache, withDependencyCacheLock } from ${JSON.stringify(source)};
const anchor = claimCreatedAnchor(process.env.ANCHOR, Number(process.env.CREATOR));
const cache = process.env.CACHE, entry = cache + "/" + "a".repeat(64);
let packagePath = anchor.path + "/package";
if (${JSON.stringify(phase)} === "hold") {
const stage = withDependencyCacheLock(cache, lock => stageDependencyCache(lock, entry, anchor));
writeFileSync(stage + "/package", "still readable");
withDependencyCacheLock(cache, lock => publishDependencyCache(lock, stage, entry, anchor));
packagePath = entry + "/package";
} else writeFileSync(packagePath, "still readable");
spawn(process.execPath, ["-e", ${JSON.stringify(`
const { readFileSync, readSync } = require("node:fs");
console.log("ready " + process.pid);
const command = Buffer.alloc(1);
while (readSync(3, command, 0, 1, null)) {
  if (command[0] === 113) break;
  console.log(readFileSync(process.env.PACKAGE, "utf8"));
}
`)}], { detached: true, env: { PACKAGE: packagePath }, stdio: ["ignore", 1, 2, Number(process.env.CONTROL_FD)] });
setInterval(() => {}, 1000);
`,
      );
      const collector = `import { rmSync } from "node:fs"; import { collectUnusedDependencyCaches, withDependencyCacheLock } from ${JSON.stringify(source)}; for (const path of withDependencyCacheLock(process.argv[1], lock => collectUnusedDependencyCaches(lock))) rmSync(path, { recursive: true });`;
      const create = resolve("scripts/pr-lib/cache-lifetime.mjs");
      const result = spawnSync(
        "python3",
        [
          "-I",
          "-S",
          "-B",
          "-c",
          `
import fcntl,json,os,signal,sqlite3,subprocess,sys
node, home, cache, parent, preload, create, collector, phase = sys.argv[1:]
env = dict(os.environ, HOME=home)
ancestors = tuple(item["fd"] for item in json.loads(env.get("OPENCLAW_PR_LIFETIME_ANCESTORS", "[]")))
read_fd,write_fd = os.pipe()
child_env = dict(env,NODE=node,PARENT=parent,CACHE=cache,FIXTURE_HOME=home,CREATE=create,PRELOAD=preload,
    CONTROL_FD=str(read_fd),PROCESS_HELPER=${JSON.stringify(processHelper)})
shell = 'ANCHOR="$FIXTURE_HOME/openclaw-pr-anchor-v3.$$.live"; mkdir -m 700 "$ANCHOR"; exec 9<"$ANCHOR"; CREATOR=$$; export ANCHOR CREATOR; OPENCLAW_PR_LIFETIME_FILE=$("$NODE" "$CREATE" create-lifetime "$ANCHOR" "$$"); export OPENCLAW_PR_LIFETIME_FILE; exec 7<>"$OPENCLAW_PR_LIFETIME_FILE"; python3 -I -S -B "$PROCESS_HELPER" shared 7; "$NODE" "$CREATE" register-lifetime "$ANCHOR" "$$"; NODE_OPTIONS="--require $PRELOAD"; export NODE_OPTIONS; exec "$NODE" "$PARENT"'
child = subprocess.Popen(["/bin/sh","-ec",shell],env=child_env,pass_fds=(read_fd,*ancestors),stdout=subprocess.PIPE,text=True)
os.close(read_fd)
reader = None
try:
    ready = child.stdout.readline().strip()
    assert ready.startswith("ready "), ready
    reader = int(ready.split()[1])
    anchor = home + "/openclaw-pr-anchor-v3." + str(child.pid) + ".live"
    with sqlite3.connect(cache+"/lifetime.sqlite") as db:
        lease = db.execute("SELECT lease_path FROM operation_lifetimes").fetchone()[0]
    child.kill()
    child.wait()
    subprocess.run([node,"--input-type=module","-e",collector,cache],env=env,pass_fds=ancestors,check=True)
    assert os.path.isdir(anchor), "Collector deleted a live child's anchor"
    os.write(write_fd,b"r")
    assert child.stdout.readline().strip() == "still readable"
    with sqlite3.connect(cache+"/lifetime.sqlite") as db:
        assert db.execute("SELECT count(*) FROM holds").fetchone()[0] == (1 if phase == "hold" else 0)
    os.write(write_fd,b"q")
    with open(lease,"r+") as unlocked:
        fcntl.flock(unlocked,fcntl.LOCK_EX)
    reader = None
    subprocess.run([node,"--input-type=module","-e",collector,cache],env=env,pass_fds=ancestors,check=True)
    assert not os.path.exists(anchor)
    assert not os.path.exists(lease)
    with sqlite3.connect(cache+"/lifetime.sqlite") as db:
        assert db.execute("SELECT count(*) FROM holds").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM operation_lifetimes").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM pending_lifetimes").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM installations WHERE settled = 0").fetchone()[0] == 0
    print("protected-until-last-child-exited")
finally:
    os.close(write_fd)
    if child.poll() is None: child.kill()
    child.wait()
    if reader:
        try: os.kill(reader,signal.SIGKILL)
        except ProcessLookupError: pass
`,
          f.node,
          f.home,
          f.cache,
          parent,
          resolve("scripts/pr-lib/dependency-lifetime-inherit.cjs"),
          create,
          collector,
          phase,
        ],
        { env: f.env, encoding: "utf8", timeout: 20_000 },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("protected-until-last-child-exited");
    },
  );

  it.each(["install", "hold"])("reclaims a SIGKILLed operation after %s", (phase) => {
    const f = fixture();
    const result = child(
      f,
      `
const stage = withDependencyCacheLock(cache, lock => stageDependencyCache(lock, entry, anchor));
fs.writeFileSync(stage + "/package", "cache bytes");
if (${JSON.stringify(phase)} !== "install") withDependencyCacheLock(cache, lock => publishDependencyCache(lock, stage, entry, anchor));
process.kill(process.pid, "SIGKILL");`,
      true,
    );
    expect(result.signal, result.stderr).toBe("SIGKILL");
    sweep(f.cache);
    expect(existsSync(f.anchor)).toBe(false);
    expect(transitions(f.cache)).toEqual([]);
    expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toEqual([]);
    if (phase === "install") {
      expect(prCacheEntries(f.cache)).toEqual([]);
      expect(readdirSync(f.cache).filter((name) => name.startsWith("install-"))).toEqual([]);
    } else {
      expect(readPrCacheState(join(f.cache, "a".repeat(64)))).toEqual({
        registered: true,
        settled: true,
        anchors: [],
      });
    }
  });

  it("recovers a collector killed after anchor removal but before settlement commits", () => {
    const f = fixture();
    const installed = child(
      f,
      `
const stage = withDependencyCacheLock(cache, lock => stageDependencyCache(lock, entry, anchor));
withDependencyCacheLock(cache, lock => publishDependencyCache(lock, stage, entry, anchor));
`,
      true,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const killed = child(
      f,
      `
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === "COMMIT" && !fs.existsSync(anchor.path)) process.kill(process.pid, "SIGKILL");
  return exec.call(this, sql);
};
withDependencyCacheLock(cache, lock => collectUnusedDependencyCaches(lock));
`,
    );
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(existsSync(f.anchor)).toBe(false);
    expect(existsSync(join(f.cache, ".metadata-lock"))).toBe(true);
    sweep(f.cache);
    expect(existsSync(join(f.cache, ".metadata-lock"))).toBe(false);
    expect(readPrCacheState(join(f.cache, "a".repeat(64)))).toEqual({
      registered: true,
      settled: true,
      anchors: [],
    });
    expect(readdirSync(f.cache).filter((name) => name.startsWith("lifetime-"))).toEqual([]);
  });

  it("recovers the ledger-first stage after publication renames it but its commit fails", () => {
    const f = fixture();
    const result = child(
      f,
      `
const stage = withDependencyCacheLock(cache, lock => stageDependencyCache(lock, entry, anchor));
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === "COMMIT") throw new Error("publication commit interrupted");
  return exec.call(this, sql);
};
try {
  withDependencyCacheLock(cache, lock => publishDependencyCache(lock, stage, entry, anchor));
} catch (error) {
  if (error.message !== "publication commit interrupted") throw error;
}
`,
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(f.cache, "a".repeat(64)))).toBe(true);
    expect(transitions(f.cache)).toHaveLength(1);
    sweep(f.cache);
    expect(prCacheEntries(f.cache)).toEqual([]);
    expect(transitions(f.cache)).toEqual([]);
    expect(existsSync(f.anchor)).toBe(false);
  });

  it("replays committed retirement intent after filesystem detach fails", () => {
    const f = fixture();
    for (let index = 0; index < 5; index++) {
      createSettledPrCacheEntry(f.cache, String(index).repeat(64));
    }
    const result = child(
      f,
      `
const rename = fs.default.renameSync;
fs.default.renameSync = function(from, ...args) {
  if (from === cache + "/" + "0".repeat(64)) throw new Error("detach interrupted");
  return rename(from, ...args);
};
syncBuiltinESMExports();
try { withDependencyCacheLock(cache, lock => collectUnusedDependencyCaches(lock)); }
catch (error) { if (error.message !== "detach interrupted") throw error; }
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(transitions(f.cache)).toMatchObject([{ entry_key: "0".repeat(64), kind: "retire" }]);
    sweep(f.cache);
    sweep(f.cache);
    expect(prCacheEntries(f.cache)).toHaveLength(4);
    expect(transitions(f.cache)).toEqual([]);
    expect(readdirSync(f.cache).filter((name) => name.startsWith("retired-"))).toEqual([]);
  });

  it("settles old legacy holds only with a complete process census", () => {
    const f = fixture();
    const entry = createSettledPrCacheEntry(f.cache, "a".repeat(64));
    const result = child(
      f,
      "withDependencyCacheLock(cache, lock => holdDependencyCache(lock, entry, anchor));",
    );
    expect(result.status, result.stderr).toBe(0);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(f.anchor, old, old);
    const before = readPrCacheState(entry);
    const complete = completeProcessCensus(f);
    sweep(f.cache);
    expect(existsSync(f.anchor)).toBe(!complete);
    expect(readPrCacheState(entry)).toEqual(
      complete ? { registered: true, settled: true, anchors: [] } : before,
    );
  });

  it("bounds orphan collection and retains entries when the process census is restricted", () => {
    const f = fixture();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (let index = 0; index < 6; index++) {
      const path = join(f.cache, String(index).repeat(64));
      mkdirSync(path, { mode: 0o700 });
      utimesSync(path, old, old);
    }
    const active = join(f.cache, "a".repeat(64));
    mkdirSync(join(active, "nested"), { recursive: true, mode: 0o700 });
    writeFileSync(join(active, "nested", "fresh"), "install in progress");
    utimesSync(active, old, old);
    utimesSync(join(active, "nested"), old, old);
    const outside = join(f.home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "outside cache");
    symlinkSync(outside, join(f.cache, "b".repeat(64)), "dir");
    const complete = completeProcessCensus(f);
    const before = prCacheEntries(f.cache).toSorted();
    sweep(f.cache);
    expect(prCacheEntries(f.cache)).toHaveLength(complete ? 4 : 8);
    sweep(f.cache);
    expect(prCacheEntries(f.cache).toSorted()).toEqual(
      complete ? ["a".repeat(64), "b".repeat(64)] : before,
    );
    expect(readdirSync(outside)).toEqual(["keep"]);
    expect(existsSync(join(active, "nested", "fresh"))).toBe(true);
  });

  it("verifies the bootstrap-native lease and process inspection contracts", () => {
    const result = spawnSync(
      "python3",
      ["-I", "-S", "-B", resolve("test/scripts/pr-cache-lifetime-process.test.py")],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
