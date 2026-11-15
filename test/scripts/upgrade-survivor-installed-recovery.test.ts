import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  installedRecoveryLaneNames,
  selectInstalledRecoveryCuts,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs";
import {
  assertInstalledRecoveryConfig,
  assertPackageTree,
  assertRetirementCut,
  capturePackageTree,
  parseRecoveryCommand,
  readActivation,
  retirementCuts,
  startInstalledRecoveryRun,
} from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import {
  findLaneByName,
  parseLaneSelection,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mts";
import { quoteCliArg } from "../../src/cli/quote-cli-arg.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const fault = pathToFileURL(
  path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-fault.mjs"),
).href;
const operation = "12345678-1234-4234-8234-123456789abc";
const command = [
  "/runtime/node",
  "/private operator's/control/recovery.mjs",
  "--anchor",
  "/private operator's/anchor",
  "--operation",
  operation,
  "status",
];
const printed = `Package publication recovery: ${command.map(quoteCliArg).join(" ")}`;

function runNodeRecoveryScript(source: string): void {
  const result = runProcess(
    node,
    ["--input-type=module", "-e", source],
    { ...process.env, NODE_OPTIONS: "" },
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
}

it("allows healthy-update bookkeeping while preserving operator settings and read-only status", () => {
  const gateway = JSON.parse(
    fs.readFileSync("scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json", "utf8"),
  );
  const original = Buffer.from(JSON.stringify({ gateway, plugins: { enabled: false } }));
  const updated = Buffer.from(
    JSON.stringify({
      ...JSON.parse(original.toString()),
      meta: { lastTouchedVersion: "next" },
      wizard: { lastRunCommand: "doctor" },
    }),
  );
  expect(() => assertInstalledRecoveryConfig(original, updated, updated)).not.toThrow();
  for (const keys of [
    ["gateway", "mode"],
    ["gateway", "port"],
    ["gateway", "bind"],
    ["gateway", "reload", "mode"],
    ["gateway", "auth", "mode"],
    ["gateway", "auth", "token", "source"],
    ["gateway", "auth", "token", "provider"],
    ["gateway", "auth", "token", "id"],
    ["plugins", "enabled"],
  ]) {
    const changed = JSON.parse(updated.toString());
    const parent = keys.slice(0, -1).reduce((value, key) => value[key], changed);
    parent[keys.at(-1)!] = null;
    const bytes = Buffer.from(JSON.stringify(changed));
    expect(() => assertInstalledRecoveryConfig(original, bytes, bytes)).toThrow(
      "operator settings",
    );
  }
  expect(() =>
    assertInstalledRecoveryConfig(original, updated, Buffer.concat([updated, Buffer.from("\n")])),
  ).toThrow("status changed full config bytes");
});

// The installed cell is Linux; use real POSIX modes and direct renames while
// keeping the portable comparator/diagnostic coverage below active on Windows.
it.skipIf(process.platform === "win32")(
  "observes exact permission tightening across package renames and preserves every entry",
  () => {
    const directory = dirs.make("installed-recovery-permissions-");
    const observations = pathToFileURL(
      path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
    ).href;
    runNodeRecoveryScript(`
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { capturePackageTree, assertPackageTree } from ${JSON.stringify(observations)};
        const directory = ${JSON.stringify(directory)};
        const original = path.join(directory, 'original');
        const displaced = path.join(directory, 'previous');
        fs.mkdirSync(path.join(original, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(original, 'payload'), 'package bytes');
        fs.linkSync(path.join(original, 'payload'), path.join(original, 'alias'));
        fs.symlinkSync('payload', path.join(original, 'entry'));
        fs.writeFileSync(path.join(original, 'node_modules/.package-lock.json'), 'hidden cache');
        fs.chmodSync(original, 0o755);
        fs.chmodSync(path.join(original, 'node_modules'), 0o750);
        fs.chmodSync(path.join(original, 'payload'), 0o644);
        fs.chmodSync(path.join(original, 'node_modules/.package-lock.json'), 0o664);
        const before = capturePackageTree(original);
        assert(before.some(entry => entry.path === ''));
        assert(before.some(entry => entry.path === 'node_modules/.package-lock.json'));
        assert.equal(before.find(entry => entry.path === 'payload').identity,
          before.find(entry => entry.path === 'alias').identity);
        assert.throws(() => assertPackageTree(before, before, { tightenPermissions: true }), /mode/);
        for (const entry of before) {
          if (entry.kind !== 'link') fs.chmodSync(path.join(original, entry.path), entry.mode & 0o7700);
        }
        fs.renameSync(original, displaced);
        const after = capturePackageTree(displaced);
        assert.throws(() => assertPackageTree(before, after), /mode/);
        assert.equal(assertPackageTree(before, after, { tightenPermissions: true }), after);
        assertPackageTree(after, capturePackageTree(displaced));
        fs.chmodSync(path.join(displaced, 'payload'), 0o644);
        assert.throws(() => assertPackageTree(after, capturePackageTree(displaced)), /mode/);
        fs.chmodSync(path.join(displaced, 'payload'), 0o600);
        for (const [name, contents] of [['payload', 'different bytes'],
          ['node_modules/.package-lock.json', 'different cache']]) {
          const file = path.join(displaced, name);
          const bytes = fs.readFileSync(file);
          const expected = capturePackageTree(displaced);
          fs.writeFileSync(file, contents);
          assert.throws(() => assertPackageTree(expected, capturePackageTree(displaced)), /content/);
          fs.writeFileSync(file, bytes);
        }
        const linked = capturePackageTree(displaced);
        fs.unlinkSync(path.join(displaced, 'entry'));
        fs.symlinkSync('alias', path.join(displaced, 'entry'));
        assert.throws(() => assertPackageTree(linked, capturePackageTree(displaced)), /link target/);
        const complete = capturePackageTree(displaced);
        fs.writeFileSync(path.join(displaced, 'unexpected'), 'new bytes');
        assert.throws(() => assertPackageTree(complete, capturePackageTree(displaced)), /added/);
        fs.unlinkSync(path.join(displaced, 'unexpected'));
        fs.unlinkSync(path.join(displaced, 'alias'));
        assert.throws(() => assertPackageTree(complete, capturePackageTree(displaced)), /removed/);
        assert.throws(() => capturePackageTree(displaced, { maxEntries: 1 }), /entry budget/);
        assert.throws(() => capturePackageTree(displaced, { maxBytes: 1 }), /byte budget/);
      `);
  },
);

it("rejects owner, special-bit, alias and partial-mode drift at the tightening boundary", () => {
  const directory = dirs.make("installed-recovery-metadata-");
  fs.writeFileSync(path.join(directory, "payload"), "package bytes");
  const captured = capturePackageTree(directory);
  const file = captured.find((entry) => entry.path === "payload")!;
  const before = [{ ...file, mode: 0o6755 }];
  const tightened = [{ ...before[0]!, mode: 0o6700 }];
  expect(assertPackageTree(before, tightened, { tightenPermissions: true })).toBe(tightened);
  for (const [field, value] of [
    ["uid", `${file.uid}-changed`],
    ["gid", `${file.gid}-changed`],
    ["identity", `${file.identity}-changed`],
    ["kind", "directory"],
    ["content", "changed bytes"],
    ["mode", 0o6600], // Lost owner execute permission.
    ["mode", 0o4700], // Lost a special bit.
    ["mode", 0o6740], // Only partly tightened.
    ["mode", 0o6777], // Widened access.
  ] as const) {
    expect(() =>
      assertPackageTree(before, [{ ...tightened[0]!, [field]: value }], {
        tightenPermissions: true,
      }),
    ).toThrow(field);
  }
  const link = { ...file, kind: "link" as const, mode: 0o777, content: "payload" };
  expect(assertPackageTree([link], [link], { tightenPermissions: true })).toEqual([link]);
  expect(() =>
    assertPackageTree([link], [{ ...link, mode: 0o700 }], { tightenPermissions: true }),
  ).toThrow("mode");
});

it("reports bounded relative drift without truncating the compared inventory or leaking bytes", () => {
  const directory = dirs.make("installed-recovery-differences-");
  for (let index = 0; index < 12; index++) {
    fs.writeFileSync(path.join(directory, `entry-${index}`), "private original contents");
  }
  const before = capturePackageTree(directory);
  for (let index = 0; index < 12; index++) {
    fs.writeFileSync(path.join(directory, `entry-${index}`), "private replacement contents");
  }
  let message = "";
  try {
    assertPackageTree(before, capturePackageTree(directory));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("12 field differences; 7 more");
  expect(message).toContain('"entry-0": content');
  expect(message).not.toContain("private original contents");
  expect(message).not.toContain("private replacement contents");
  expect(message).not.toContain(directory);
  expect(message.length).toBeLessThan(800);
});

it("bounds directory discovery before sorting and closes handles on entry overflow", () => {
  const directory = dirs.make("installed-recovery-entry-budget-");
  const observations = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
  ).href;
  runNodeRecoveryScript(`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { capturePackageTree } from ${JSON.stringify(observations)};
      const directory = ${JSON.stringify(directory)};
      const wide = path.join(directory, 'wide');
      const empty = path.join(directory, 'empty');
      const nested = path.join(directory, 'nested');
      fs.mkdirSync(wide);
      fs.mkdirSync(empty);
      for (let index = 63; index >= 0; index--) {
        fs.writeFileSync(path.join(wide, 'entry-' + index), 'bytes');
      }
      const names = Array.from({ length: 64 }, (_, index) => 'entry-' + index);
      assert.deepEqual(capturePackageTree(wide, { maxEntries: 65 }).map(entry => entry.path),
        ['', ...names.toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0)]);
      assert.deepEqual(capturePackageTree(empty, { maxEntries: 1 }).map(entry => entry.path), ['']);
      fs.mkdirSync(path.join(nested, 'z'), { recursive: true });
      fs.mkdirSync(path.join(nested, 'a'));
      fs.writeFileSync(path.join(nested, 'a', 'payload'), 'bytes');
      assert.deepEqual(capturePackageTree(nested, { maxEntries: 4 }).map(entry => entry.path),
        ['', 'a', path.join('a', 'payload'), 'z']);
      const opendir = fs.opendirSync;
      const lstat = fs.lstatSync;
      const handles = [];
      const visited = [];
      let reads = 0;
      fs.opendirSync = (...args) => {
        const handle = opendir(...args);
        const read = handle.readSync.bind(handle);
        handle.readSync = () => { reads++; return read(); };
        handles.push(handle);
        return handle;
      };
      fs.lstatSync = (file, ...args) => {
        visited.push(path.relative(nested, file));
        return lstat(file, ...args);
      };
      try {
        assert.throws(() => capturePackageTree(wide, { maxEntries: 3 }), /entry budget/);
        assert.equal(reads, 3);
        assert.equal(handles.length, 1);
        assert.throws(() => handles[0].readSync(), { code: 'ERR_DIR_CLOSED' });
        reads = 0;
        handles.length = 0;
        visited.length = 0;
        assert.throws(() => capturePackageTree(nested, { maxEntries: 3 }), /entry budget/);
        assert.deepEqual(visited, ['', 'a']);
        assert.equal(reads, 4);
        assert.equal(handles.length, 2);
        for (const handle of handles) {
          assert.throws(() => handle.readSync(), { code: 'ERR_DIR_CLOSED' });
        }
      } finally {
        fs.opendirSync = opendir;
        fs.lstatSync = lstat;
      }
    `);
});

it("extracts a sealed helper beyond Node's buffered limit and closes owned output files", () => {
  const directory = dirs.make("installed-recovery-package-");
  const extractor = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-package.mjs"),
  ).href;
  // Use real Node even when Vitest runs on Bun: the Docker driver owns this limit.
  runNodeRecoveryScript(`
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import fs from 'node:fs';
      import path from 'node:path';
      import { extractPackedRecoveryHelper } from ${JSON.stringify(extractor)};
      const directory = ${JSON.stringify(directory)};
      const member = 'package/dist/package-update-activation-recovery.mjs';
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 73, 0x51);
      fs.mkdirSync(path.join(directory, 'package/dist'), { recursive: true });
      fs.writeFileSync(path.join(directory, member), bytes);
      const archive = path.join(directory, 'source.tgz');
      execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
      assert.throws(() => execFileSync('tar', ['-xOf', archive, member]), { code: 'ENOBUFS' });
      const destination = path.join(directory, 'recovery.mjs');
      const open = fs.openSync;
      let descriptor;
      fs.openSync = (...args) => {
        const result = open(...args);
        if (args[0] === destination && args[1] === 'wx') descriptor = result;
        return result;
      };
      try {
        extractPackedRecoveryHelper(archive, destination);
        assert.deepEqual(fs.readFileSync(destination), bytes);
        assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
        assert.throws(() => extractPackedRecoveryHelper(archive, destination), { code: 'EEXIST' });
        assert.deepEqual(fs.readFileSync(destination), bytes);
        fs.unlinkSync(destination);
        fs.mkdirSync(path.join(directory, 'empty'));
        const missing = path.join(directory, 'missing.tgz');
        execFileSync('tar', ['-czf', missing, '-C', directory, 'empty']);
        assert.throws(() => extractPackedRecoveryHelper(missing, destination));
        assert.equal(fs.existsSync(destination), false);
        assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
      } finally {
        fs.openSync = open;
      }
    `);
});

it.skipIf(process.platform === "win32")(
  "keeps shared evidence readable through restrictive umask",
  () => {
    const directory = dirs.make("installed-recovery-evidence-");
    const observations = pathToFileURL(
      path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
    ).href;
    runNodeRecoveryScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { startInstalledRecoveryRun, openInstalledRecoveryEvidence, writeInstalledRecoveryEvidence } from ${JSON.stringify(observations)};
    for (const mode of [0o700, 0o2770, 0o2777]) {
      const shared = mode === 0o2770;
      const root = path.join(${JSON.stringify(directory)}, String(mode));
      fs.mkdirSync(root); fs.chmodSync(root, mode);
      const mask = process.umask(0o777);
      try {
        const run = startInstalledRecoveryRun(root, 'partial-previous');
        const output = path.join(run.directory, 'install.log');
        const fd = openInstalledRecoveryEvidence(output);
        try { fs.writeFileSync(fd, 'private bytes'); } finally { fs.closeSync(fd); }
        writeInstalledRecoveryEvidence(run.summary, { status: 'running' });
        assert.equal(fs.statSync(run.directory).mode & 0o7777, shared ? 0o2750 : 0o700);
        for (const file of [output, run.summary]) {
          assert.equal(fs.statSync(file).mode & 0o777, shared ? 0o640 : 0o600);
          assert.equal(fs.statSync(file).gid, fs.statSync(root).gid);
          assert(fs.readFileSync(file).length > 0);
        }
        const link = path.join(root, 'linked'); fs.symlinkSync(run.directory, link);
        assert.throws(() => openInstalledRecoveryEvidence(path.join(link, 'unsafe')), /physical directory/);
      } finally { process.umask(mask); }
    }
  `);
  },
);

it("invalidates an earlier PASS before setup and isolates repeated attempts", () => {
  const artifacts = dirs.make("installed-recovery-runs-");
  const first = startInstalledRecoveryRun(artifacts);
  const earlier = path.join(first.directory, "independent-recovery.mjs");
  fs.writeFileSync(earlier, "earlier helper");
  writeJson(first.summary, { status: "passed", runDirectory: path.basename(first.directory) });

  const second = startInstalledRecoveryRun(artifacts);
  expect(second.directory).not.toBe(first.directory);
  expect(second.summary).toBe(first.summary);
  expect(readJson(second.summary)).toEqual({
    status: "running",
    runDirectory: path.basename(second.directory),
    selectedCuts: retirementCuts,
  });
  expect(fs.readFileSync(earlier, "utf8")).toBe("earlier helper");
  const helper = path.join(second.directory, "independent-recovery.mjs");
  fs.writeFileSync(helper, "current helper", { flag: "wx" });
  expect(() => fs.writeFileSync(helper, "duplicate setup", { flag: "wx" })).toThrow();
  expect(readJson(second.summary).status).toBe("running");
  expect(fs.readFileSync(helper, "utf8")).toBe("current helper");
});

it("records the explicit older-runtime proof without changing default retirement coverage", () => {
  const artifacts = dirs.make("older-runtime-run-");
  const run = startInstalledRecoveryRun(artifacts, "older-runtime");
  expect(readJson(run.summary).selectedCuts).toEqual(["older-runtime"]);
  expect(readJson(startInstalledRecoveryRun(artifacts).summary).selectedCuts).toEqual(
    retirementCuts,
  );
});

it("reads the printed recovery argv without evaluating quoted shell text", () => {
  expect(parseRecoveryCommand(`ordinary output\n${printed}\nordinary error`)).toEqual({
    node: command[0],
    helper: command[1],
    anchor: command[3],
    operation,
  });
  for (const invalid of [
    `${printed}; echo injected`,
    printed.replace("/runtime/node", "$(echo injected)"),
    printed.replace("/runtime/node", "NODE_OPTIONS=--import=other /runtime/node"),
    `${printed}\n${printed}`,
    printed.replace(" status", " repair"),
  ]) {
    expect(() => parseRecoveryCommand(invalid)).toThrow();
  }
});

it("selects every isolated recovery cell without expanding the published baseline matrix", () => {
  expect(retirementCuts).toEqual([
    "partial-previous",
    "anchor-before",
    "anchor-after",
    "anchor-sync",
    "helper-before",
    "helper-after",
    "helper-sync",
  ]);
  const { plan } = resolveDockerE2ePlan({
    allowFrozenTargetScenarioOmissions: true,
    includeOpenWebUI: false,
    liveMode: "all",
    orderLanes: (lanes) => lanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: parseLaneSelection("package-installed-recovery"),
    timingStore: undefined,
  });
  expect(plan.lanes.map((lane) => lane.name)).toEqual(installedRecoveryLaneNames);
  for (const [sequence, cut] of retirementCuts.entries()) {
    const lane = plan.lanes[sequence]!;
    expect(lane).toMatchObject({
      imageKind: "bare",
      stateScenario: "empty",
      live: false,
      timeoutMs: 1_200_000,
    });
    expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=package-installed-recovery");
    expect(lane.command).toContain(`OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT=${cut}`);
    expect(lane.command).toContain("OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=0");
    expect(selectInstalledRecoveryCuts(cut)).toEqual([[sequence, cut]]);
  }
  expect(selectInstalledRecoveryCuts()).toEqual([...retirementCuts.entries()]);
  expect(() => selectInstalledRecoveryCuts("unknown")).toThrow("Unknown installed recovery cut");
});

// The lane's Bash entrypoint executes in Linux Docker jobs; portable catalog
// selection above remains covered on Windows without assuming a POSIX shell.
it.skipIf(process.platform === "win32").each(retirementCuts)(
  "isolates the %s writer from inherited published-survivor settings",
  (cut) => {
    const harness = dirs.make("installed-recovery-command-");
    const script = path.join(harness, "scripts/e2e/upgrade-survivor-docker.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    const inheritedMode = {
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@latest",
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
      OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS: "1",
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS: "openai/example",
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
      OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT: "unrelated",
    };
    const observe = `printf '%s\n' ${Object.keys(inheritedMode)
      .map((name) => `"$${name}"`)
      .join(" ")}`;
    fs.writeFileSync(script, `#!/bin/bash\nset -eu\n${observe}\n`);
    const lane = findLaneByName(`package-installed-recovery-${cut}`);
    expect(lane).toBeDefined();
    const result = runProcess(
      "/bin/bash",
      ["-c", `set -eu\n${lane!.command}\n${observe}`],
      {
        ...process.env,
        ...inheritedMode,
        OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR: harness,
        BASH_ENV: "",
        ENV: "",
      },
      10_000,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "package-installed-recovery",
      "0",
      "",
      "manual",
      "0",
      "",
      "0",
      cut,
      ...Object.values(inheritedMode),
      "",
    ]);
  },
);

function fixture(cut: string) {
  const directory = fs.realpathSync(dirs.make("installed-recovery-observer-"));
  const root = path.join(directory, "openclaw");
  const anchor = path.join(directory, "activation");
  const helper = path.join(`${anchor}.control`, "recovery.mjs");
  const journal = path.join(`${anchor}.control`, "operation.sqlite");
  const evidence = path.join(directory, "observed.json");
  const spec = path.join(directory, "fault.json");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "selected"), "selected package bytes");
  fs.mkdirSync(`${anchor}.control`);
  fs.writeFileSync(helper, "original helper bytes");
  if (!cut.startsWith("helper-")) {
    fs.mkdirSync(anchor);
  }
  if (cut === "partial-previous") {
    fs.mkdirSync(path.join(anchor, "previous"));
    fs.writeFileSync(path.join(anchor, "previous/first"), "first obsolete leaf");
    fs.writeFileSync(path.join(anchor, "previous/second"), "remaining obsolete leaf");
  }
  const intent =
    cut === "displaced"
      ? { kind: "displace" }
      : cut === "partial-previous"
        ? { kind: "remove", name: "previous", selected: "candidate" }
        : {
            kind: cut.startsWith("anchor-") ? "remove-anchor" : "unlink-helper",
            selected: "candidate",
          };
  const phase =
    cut === "displaced" ? "publishing" : cut.startsWith("helper-") ? "anchor-retired" : "retiring";
  const db = new DatabaseSync(journal);
  db.exec(
    "CREATE TABLE package_activation(slot INTEGER, phase TEXT, intent_json TEXT, descriptor_json TEXT)",
  );
  db.prepare("INSERT INTO package_activation VALUES(1,?,?,?)").run(
    phase,
    JSON.stringify(intent),
    JSON.stringify({ operationId: operation, authority: { installKey: root } }),
  );
  db.close();
  const before = readActivation(journal);
  writeJson(spec, { cut, root, anchor, helper, journal, evidence });
  const run = (body: string, preloads: string[] = []) =>
    runProcess(
      node,
      [
        ...preloads,
        "--import",
        fault,
        "--input-type=module",
        "-e",
        `import fs from 'node:fs/promises';\nconst root=${JSON.stringify(root)};\nconst anchor=${JSON.stringify(anchor)};\nconst helper=${JSON.stringify(helper)};\n${body}`,
      ],
      { ...process.env, NODE_OPTIONS: "", OPENCLAW_SURVIVOR_INSTALLED_RECOVERY_FAULT: spec },
      10_000,
    );
  return { root, anchor, helper, journal, evidence, directory, before, run };
}

function observerEvents(stderr: string, directory: string) {
  const prefix = "[installed-recovery/observer] ";
  let previousElapsed = 0;
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      expect(Buffer.byteLength(line)).toBeLessThan(256);
      expect(line).not.toContain(directory);
      const event = JSON.parse(line.slice(prefix.length));
      expect(Object.keys(event)).toEqual([
        "event",
        "pid",
        "ppid",
        "node",
        "platform",
        "arch",
        "elapsedMs",
      ]);
      expect(event.pid).toBeGreaterThan(0);
      expect(event.ppid).toBeGreaterThan(0);
      expect(event.node).toMatch(/^v\d+\.\d+\.\d+$/u);
      expect(event.platform).toBe(process.platform);
      expect(event.arch).toBe(process.arch);
      expect(event.elapsedMs).toBeGreaterThanOrEqual(previousElapsed);
      expect(event.elapsedMs).toBeLessThan(10_000);
      previousElapsed = event.elapsedMs;
      return event.event;
    });
}

it.each(["unmatched", "rename-rejected", "journal-rejected"])(
  "records only reached displacement boundaries: %s",
  (failure) => {
    const f = fixture("displaced");
    if (failure === "rename-rejected") {
      fs.renameSync(f.root, `${f.root}.unselected`);
    } else if (failure === "journal-rejected") {
      const db = new DatabaseSync(f.journal);
      try {
        db.exec("UPDATE package_activation SET phase='prepared'");
      } finally {
        db.close();
      }
    }
    const body =
      failure === "unmatched"
        ? `await fs.rename(root, ${JSON.stringify(path.join(f.anchor, "unrelated"))});`
        : failure === "rename-rejected"
          ? `for (let attempt = 0; attempt < 8; attempt++) {
              try { await fs.rename(root, ${JSON.stringify(path.join(f.anchor, "previous"))}); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }`
          : `await fs.rename(root, ${JSON.stringify(path.join(f.anchor, "previous"))});`;
    const result = f.run(body);
    expect(result.status).toBe(failure === "journal-rejected" ? 1 : 0);
    expect(observerEvents(result.stderr, f.directory)).toEqual([
      "hooks-armed",
      ...(failure === "unmatched" ? [] : ["matching-rename-entered"]),
      ...(failure === "journal-rejected" ? ["rename-returned"] : []),
    ]);
    expect(fs.existsSync(f.evidence)).toBe(false);
  },
);

it("preserves every native Node SQLite column across strict JSON snapshots", () => {
  const f = fixture("displaced");
  const observations = pathToFileURL(
    path.resolve("scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs"),
  ).href;
  // Vitest may run on Bun; the installed driver uses Node's null-prototype rows.
  runNodeRecoveryScript(`
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { readActivation } from ${JSON.stringify(observations)};
      const journal = ${JSON.stringify(f.journal)};
      const db = new DatabaseSync(journal, { readOnly: true });
      try {
        const raw = db.prepare('SELECT * FROM package_activation').get();
        assert.equal(Object.getPrototypeOf(raw), null);
        assert.deepEqual(readActivation(journal), JSON.parse(JSON.stringify(raw)));
      } finally {
        db.close();
      }
    `);
});

// These tests qualify the observer's physical boundaries, not installed recovery.
// Windows self-termination has no SIGKILL receipt and read-only directory sync
// has different semantics; the Docker cell requires the real POSIX boundaries.
it.skipIf(process.platform === "win32").each(["displaced", ...retirementCuts])(
  "interrupts at the designated real effect boundary: %s",
  (cut) => {
    const f = fixture(cut);
    const effects: Record<string, string> = {
      displaced: "await fs.rename(root, anchor + '/previous');",
      "partial-previous": "await fs.unlink(anchor + '/previous/first');",
      "anchor-before": "await fs.rmdir(anchor);",
      "anchor-after": "await fs.rmdir(anchor);",
      "anchor-sync": `await fs.rmdir(anchor); const handle = await fs.open(${JSON.stringify(f.directory)}, 'r'); await handle.sync(); await handle.close();`,
      "helper-before": "await fs.unlink(helper);",
      "helper-after": "await fs.unlink(helper);",
      "helper-sync":
        "await fs.unlink(helper); const handle = await fs.open(anchor + '.control', 'r'); await handle.sync(); await handle.close();",
    };
    const result = f.run(effects[cut]!);
    expect(result.signal, result.stderr).toBe("SIGKILL");
    expect(observerEvents(result.stderr, f.directory)).toEqual([
      "hooks-armed",
      ...(cut === "displaced"
        ? ["matching-rename-entered", "rename-returned", "journal-assertions-validated"]
        : []),
    ]);
    const observed = readJson(f.evidence);
    expect(observed.row).toEqual(f.before);
    expect(readActivation(f.journal)).toEqual(f.before);
    if (cut === "displaced") {
      expect(fs.existsSync(f.root)).toBe(false);
      expect(fs.readFileSync(path.join(f.anchor, "previous/selected"), "utf8")).toBe(
        "selected package bytes",
      );
    } else {
      assertRetirementCut(cut, observed, f.anchor, f.helper);
      expect(fs.readFileSync(path.join(f.root, "selected"), "utf8")).toBe("selected package bytes");
    }
    if (cut === "partial-previous") {
      expect(fs.readFileSync(path.join(f.anchor, "previous/second"), "utf8")).toBe(
        "remaining obsolete leaf",
      );
    }
  },
);

it("does not claim a directory-sync cut when the real FileHandle.sync rejects", () => {
  const f = fixture("anchor-sync");
  const bootstrap = path.join(f.directory, "reject-sync.mjs");
  fs.writeFileSync(
    bootstrap,
    `
    import fs from 'node:fs/promises';
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (args[0] === ${JSON.stringify(f.directory)}) handle.sync = async () => { throw new Error('real sync rejected'); };
      return handle;
    };
  `,
  );
  const result = f.run(
    `
    await fs.rmdir(anchor);
    const handle = await fs.open(${JSON.stringify(f.directory)}, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  `,
    ["--import", pathToFileURL(bootstrap).href],
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("real sync rejected");
  expect(fs.existsSync(f.evidence)).toBe(false);
  expect(readActivation(f.journal)).toEqual(f.before);
});
