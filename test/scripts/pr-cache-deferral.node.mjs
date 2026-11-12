import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const owner = resolve("scripts/pr-lib/cache-lifetime.mjs");
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const flag = "OPENCLAW_PR_DEFER_CACHE_COLLECTION";

function fixture(t, value) {
  // openclaw-temp-dir: allow dependency-free subprocess fixtures own HOME and cleanup.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-cache-deferral-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, TMPDIR: root, TMP: root, TEMP: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCLAW_PR_")) delete env[key];
  }
  if (value !== undefined) env[flag] = value;
  return { root, env };
}

function run(args, env, options = {}) {
  return spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
    timeout: 15_000,
    ...options,
  });
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function operation() {
  const [mode, anchorPath] = process.argv.slice(3);
  const cache = join(process.env.HOME, ".cache/openclaw/pr-dependencies/v3");
  let retirements = 0;
  let collectionQueries = 0;
  let collecting = false;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (collecting && sql === "SELECT * FROM pending_lifetimes") collectionQueries++;
    return prepare.call(this, sql);
  };
  const spawn = childProcess.spawnSync;
  // The real owner and ledger run. Only shared process inspection/retirement is
  // intercepted, so neither the regression nor its default control scans hosts.
  childProcess.spawnSync = (command, args, options) => {
    if (command === "python3") {
      assert.equal(args[2], "-c", "unexpected process adapter invocation");
      if (args[4] === "retire") {
        retirements++;
        const { candidates } = JSON.parse(options.input);
        return {
          status: 0,
          stdout: JSON.stringify({ results: candidates.map(({ id }) => ({ id, state: "held" })) }),
          stderr: "",
        };
      }
      assert.equal(args[4], "shared", "unexpected process inspection");
    }
    return spawn(command, args, options);
  };
  syncBuiltinESMExports();
  const api = await import(pathToFileURL(owner));
  const anchor = api.claimCreatedAnchor(anchorPath, process.ppid);
  assert.throws(() => api.claimCreatedAnchor(anchorPath, process.ppid + 1), /descriptor differs/);
  const entry = join(cache, "a".repeat(64));
  api.withDependencyCacheLock(cache, (lock) => {
    const stage = api.stageDependencyCache(lock, entry, anchor);
    for (const name of ["tsx", "zod", "minimatch", "yaml"]) {
      const path = join(stage, "node_modules", name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    }
    api.publishDependencyCache(lock, stage, entry, anchor);
  });
  const destination = join(anchorPath, "node_modules");
  assert.equal(api.privateDependencyDonor(entry, destination), true);
  succeeded(
    run(
      [
        resolve("scripts/pr-lib/materialize-dependencies.mjs"),
        join(entry, "node_modules"),
        destination,
      ],
      process.env,
    ),
  );
  assert.equal(realpathSync(join(destination, "tsx")), join(entry, "node_modules/tsx"));

  if (mode === "retire-owned") {
    let retired = false;
    api.retireAnchorDependencies(anchor, () => {
      rmSync(anchorPath, { recursive: true });
      retired = true;
    });
    assert.equal(retired, true);
    assert.equal(existsSync(anchorPath), false);
    assert.equal(retirements, 0, "own retirement must not run shared collection");
    const db = new DatabaseSync(join(cache, "lifetime.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT settled FROM installations").get().settled, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM holds").get().n, 0);
    } finally {
      db.close();
    }
  } else {
    const db = new DatabaseSync(join(cache, "lifetime.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM operation_lifetimes").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM holds").get().n, 1);
    } finally {
      db.close();
    }
    collecting = true;
    // Retained 701034/28b82 wrappers call this export after materialization,
    // passing their selected installation. They do not call the current sweep.
    const retired = api.withDependencyCacheLock(cache, (lock) =>
      api.collectUnusedDependencyCaches(lock, entry),
    );
    collecting = false;
    assert.deepEqual(retired, []);
    const deferred = process.env[flag] === "1";
    assert.equal(collectionQueries, deferred ? 0 : 1);
    assert.equal(retirements, deferred ? 0 : 1);
    assert.throws(() => api.collectUnusedDependencyCaches({}), /lock ownership changed/);
    let removed = false;
    api.retireAnchorDependencies(anchor, () => {
      removed = true;
    });
    assert.equal(removed, false, "FD7 operation lifetime remains protected");
  }
}

if (process.argv[2] === "operation") {
  await operation();
} else {
  test("wrapper skips only optional collection and rejects invalid values", (t) => {
    const source = readFileSync("scripts/pr", "utf8");
    const collect = source.match(/^pr_collect_dependencies\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(collect);
    for (const value of [undefined, "1", "", "0", "true"]) {
      const f = fixture(t, value);
      const result = spawnSync(
        bash,
        [
          "-c",
          `${collect}\nnode() { echo collection; }\nrequested_subcommand=review-guard\npr_collect_dependencies fixture || exit $?\necho operation`,
        ],
        { env: f.env, encoding: "utf8" },
      );
      if (value === undefined || value === "1") {
        succeeded(result);
        assert.equal(result.stdout, value === "1" ? "operation\n" : "collection\noperation\n");
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /OPENCLAW_PR_DEFER_CACHE_COLLECTION/);
        assert.equal(result.stdout, "");
      }
    }
  });

  test("sweep defers before cache discovery; CLI does not swallow invalid flags", (t) => {
    for (const value of [undefined, "1", "", "0", "true"]) {
      const f = fixture(t, value);
      f.env.HOME = join(f.root, "missing-home");
      const result = run(
        value === undefined || value === "1"
          ? [
              "--input-type=module",
              "-e",
              `import { sweepDependencyCaches } from ${JSON.stringify(pathToFileURL(owner).href)}; sweepDependencyCaches();`,
            ]
          : [owner, "collect"],
        f.env,
      );
      if (value === "1") succeeded(result);
      else {
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          value === undefined ? /ENOENT/ : /OPENCLAW_PR_DEFER_CACHE_COLLECTION/,
        );
      }
    }
  });

  for (const [mode, value] of [
    ["collect", "1"],
    ["collect", undefined],
    ["retire-owned", "1"],
  ]) {
    test(
      `${mode} with deferral ${value ?? "unset"} preserves donor and lifetime ownership`,
      { skip: process.platform === "win32" },
      (t) => {
        const f = fixture(t, value);
        const anchor = join(f.root, `openclaw-pr-anchor-v3.${process.pid}.fixture`);
        mkdirSync(anchor, { mode: 0o700 });
        const fd = openSync(anchor, "r");
        const stdio = ["ignore", "pipe", "pipe", ...Array(6).fill("ignore"), fd];
        let leaseFd;
        try {
          if (mode === "collect") {
            const created = run([owner, "create-lifetime", anchor, String(process.pid)], f.env, {
              stdio,
            });
            succeeded(created);
            leaseFd = openSync(created.stdout, "r+");
            stdio[7] = leaseFd;
            f.env.OPENCLAW_PR_LIFETIME_FILE = created.stdout;
            succeeded(
              spawnSync(
                "python3",
                ["-I", "-B", resolve("scripts/pr-lib/cache-lifetime-process.py"), "shared", "7"],
                { stdio, env: f.env, encoding: "utf8" },
              ),
            );
            succeeded(
              run([owner, "register-lifetime", anchor, String(process.pid)], f.env, { stdio }),
            );
          }
          succeeded(run([self, "operation", mode, anchor], f.env, { stdio }));
        } finally {
          if (leaseFd !== undefined) closeSync(leaseFd);
          closeSync(fd);
        }
      },
    );
  }
}
