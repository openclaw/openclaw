import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";
import { collectPackageDistImportErrors } from "../../scripts/lib/package-dist-imports.mjs";
import { withUpdateCommandExecutor } from "../../src/cli/update-cli/update-command-executor.js";
import {
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../src/infra/package-update-activation-journal.js";
import { preparePackageActivationJournal } from "../../src/infra/package-update-activation-prepare.js";
import { packageActivationRuntimeEntrypoint } from "../../src/infra/package-update-activation-runtime-assets.js";
import { packageActivationRuntimeForTest } from "../../src/infra/package-update-activation-runtime.test-support.js";
import { createPackageIntegrityReader } from "../../src/infra/package-update-integrity.js";
import { createPackageSwapFixture } from "../../src/infra/package-update-swap.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../src/infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../src/infra/update-managed-service-handoff-runtime.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

// The test runner relocates worker declarations; the production factory needs source metadata.
vi.mock(
  "../../src/infra/update-managed-service-handoff-runtime-assets.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/infra/update-managed-service-handoff-runtime-assets.js")
      >();
    return {
      ...actual,
      managedHandoffRuntimeEntrypoint: {
        ...actual.managedHandoffRuntimeEntrypoint,
        currentModuleUrl: new URL(
          "../../src/infra/update-managed-service-handoff-runtime-assets.ts",
          import.meta.url,
        ).href,
      },
    };
  },
);

vi.mock("../../src/infra/package-update-activation-runtime-assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/infra/package-update-activation-runtime-assets.js")
    >();
  return {
    ...actual,
    packageActivationRuntimeEntrypoint: {
      ...actual.packageActivationRuntimeEntrypoint,
      currentModuleUrl: new URL(
        "../../src/infra/package-update-activation-runtime-assets.ts",
        import.meta.url,
      ).href,
    },
  };
});

vi.mock("../../src/infra/runtime-worker-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infra/runtime-worker-url.js")>();
  return { ...actual, resolveRuntimeWorkerUrl: vi.fn(actual.resolveRuntimeWorkerUrl) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const packageDir = (name: string) => path.dirname(require.resolve(`${name}/package.json`));
function commandOutput(result: ReturnType<typeof spawnSync>, status = 0) {
  expect({ error: result.error, status: result.status }, String(result.stderr)).toEqual({
    error: undefined,
    status,
  });
  return String(result.stdout);
}
const commandFacts = (result: ReturnType<typeof spawnSync>) => JSON.parse(commandOutput(result));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const freebsd = process.platform === "freebsd";
const windows = process.platform === "win32";

afterEach(() => vi.restoreAllMocks());

function publishedProcSafeRuntimeFiles(packageDirectory: string): string[] {
  const root = realpathSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    files: string[];
  };
  const published = globSync(manifest.files, { cwd: root });
  for (const file of published) {
    const relative = path.relative(root, realpathSync(path.resolve(root, file)));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Published proc-safe file escapes its package: ${file}`);
    }
  }
  // Staging retains package metadata and licensing, plus published JavaScript under dist.
  return [
    "package.json",
    "LICENSE",
    ...new Set(
      published.filter(
        (file) =>
          file.startsWith(`dist${path.sep}`) &&
          file.endsWith(".js") &&
          lstatSync(path.join(root, file)).isFile(),
      ),
    ),
  ].toSorted();
}

it.each(
  (["managed", "package"] as const).filter(
    (kind) => kind === "managed" || process.platform !== "win32",
  ),
)("loads the staged production %s runtime without neighboring assets", async (kind) => {
  const runtimeEntry =
    kind === "managed"
      ? MANAGED_HANDOFF_RUNTIME_ENTRY
      : packageActivationRuntimeEntrypoint.distWorkerPath;
  const entryName = runtimeEntry.replace(/\.mjs$/u, "");
  const config = buildConfigs.find(
    ({ entry }) => typeof entry === "object" && entry !== null && Object.hasOwn(entry, entryName),
  );
  if (!config) {
    throw new Error("Missing production managed handoff build config");
  }
  const root = realpathSync(tempDirs.make("openclaw-handoff-build-"));
  const outDir = path.join(root, "build");
  const directory = path.join(root, "stage");
  const control = path.join(root, "authority");
  for (const dir of [outDir, directory, control]) {
    mkdirSync(dir, { mode: 0o700 });
  }
  const { databasePath } = installPrivateUpdateHandoffStore(control);
  const guardEnv = writePrivateUpdateHandoffChildGuard(databasePath, control);
  const childEnv = guardEnv({
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: control,
    TMP: control,
    TEMP: control,
    OPENCLAW_STATE_DIR: path.join(control, "state"),
    OPENCLAW_CONFIG_PATH: path.join(control, "state", "openclaw.json"),
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
  });
  const commands: string[] = [];
  let preparedPackage: Awaited<ReturnType<typeof preparePackageActivationJournal>> | undefined;
  let prepareNext: (() => Promise<NonNullable<typeof preparedPackage>>) | undefined;
  const childOptions = {
    encoding: "utf8",
    timeout: 30_000,
    cwd: directory,
    env: childEnv,
  } as const;
  const runCommand = (command: string, action: string) =>
    spawnSync("/bin/sh", ["-c", command.replace(/ status$/u, ` ${action}`)], {
      ...childOptions,
      killSignal: "SIGKILL",
    });
  const assertPhases = (command: string, operationId: string, phases: string[][]) => {
    for (const [action, phase] of phases) {
      expect(commandFacts(runCommand(command, action!))).toMatchObject({ operationId, phase });
    }
  };
  // Use the production graph unchanged, not the invocation compiler's extra plugins.
  const { bundles } = await build({ ...config, config: false, outDir, logLevel: "silent" });
  try {
    const modules = bundles.flatMap(({ chunks }) =>
      chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])),
    );
    const loader =
      kind === "managed" ? "update-managed-service-handoff" : "package-update-activation";
    expect(modules).toContain(path.resolve(`src/infra/${loader}-native-loader.ts`));
    // Lease observation and error metadata must not capture execution controllers.
    for (const module of [
      "src/shared/freebsd-process-identity-native.ts",
      ...(kind === "package"
        ? [
            "src/infra/update-managed-service-handoff.ts",
            "src/flows/doctor-health-contributions.ts",
          ]
        : []),
    ]) {
      expect(modules, module).not.toContain(path.resolve(module));
    }
    const runtimeWorker = await vi.importActual<
      typeof import("../../src/infra/runtime-worker-url.js")
    >("../../src/infra/runtime-worker-url.js");
    vi.mocked(resolveRuntimeWorkerUrl).mockImplementation((entry) =>
      entry.distWorkerPath === runtimeEntry
        ? pathToFileURL(path.join(outDir, runtimeEntry))
        : runtimeWorker.resolveRuntimeWorkerUrl(entry),
    );
    const helperName = "windows-security-helper.exe";
    const publishedHelper = readFileSync(
      path.join(packageDir("@openclaw/fs-safe"), "dist", helperName),
    );
    expect(readFileSync(path.join(outDir, helperName))).toEqual(publishedHelper);
    const packageFiles = globSync("**/*", { cwd: outDir })
      .filter((name) => lstatSync(path.join(outDir, name)).isFile())
      .map((name) => `dist/${name.replaceAll(path.sep, "/")}`);
    const readPackageText = (name: string) =>
      readFileSync(path.join(outDir, name.slice("dist/".length)), "utf8");
    expect(
      collectPackageDistImportErrors({ files: packageFiles, readText: readPackageText }),
    ).toEqual([]);
    // Reproduce the original archive defect without compiling an unchanged baseline.
    expect(
      collectPackageDistImportErrors({
        files: packageFiles.filter((name) => name !== `dist/${helperName}`),
        readText: readPackageText,
      }),
    ).toContain(`dist/${runtimeEntry} imports missing dist/${helperName}`);
    let entry: string;
    if (kind === "managed") {
      // The repository runner compiles a separate graph from this production build.
      const invocationAssets = await vi.importActual<
        typeof import("../../src/infra/update-managed-service-handoff-runtime-assets.js")
      >("../../src/infra/update-managed-service-handoff-runtime-assets.js");
      const invocationEntry = runtimeWorker.resolveRuntimeWorkerUrl(
        invocationAssets.managedHandoffRuntimeEntrypoint,
      );
      expect(readFileSync(new URL(`./${helperName}`, invocationEntry))).toEqual(publishedHelper);
      const manifest = JSON.parse(
        readFileSync(new URL("../manifest.json", invocationEntry), "utf8"),
      );
      const helperHash = sha256(publishedHelper);
      expect(manifest.outputs[helperName]).toBe(helperHash);
      if (manifest.cacheSignature) {
        for (const file of [`dist/${helperName}`, "package.json"]) {
          const source = realpathSync(path.join(packageDir("@openclaw/fs-safe"), file));
          expect(manifest.inputs[source]).toBe(sha256(readFileSync(source)));
        }
      }
      if (windows) {
        rmSync(path.join(outDir, helperName));
        try {
          expect(() => stageManagedHandoffRuntime(directory)).toThrow(/ENOENT/);
          expect(readdirSync(path.join(directory, "runtime"))).toEqual([
            MANAGED_HANDOFF_RUNTIME_ENTRY,
          ]);
        } finally {
          rmSync(path.join(directory, "runtime"), { recursive: true, force: true });
          writeFileSync(path.join(outDir, helperName), publishedHelper);
        }
      }
      const staged = stageManagedHandoffRuntime(directory);
      entry = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
      const privateModules = path.join(directory, "runtime", "node_modules");
      const procSafeRoot = path.join(privateModules, "@openclaw", "proc-safe");
      const addonRoot = path.join(privateModules, "@openclaw", `proc-safe-freebsd-${process.arch}`);
      const nativeAssets = freebsd
        ? [
            ...publishedProcSafeRuntimeFiles(packageDir("@openclaw/proc-safe")).map((file) =>
              path.join(procSafeRoot, file),
            ),
            ...["package.json", "proc-safe-native.node"].map((file) => path.join(addonRoot, file)),
          ]
        : [];
      const windowsAssets = windows ? [path.join(path.dirname(entry), helperName)] : [];
      expect(staged.toSorted()).toEqual([entry, ...nativeAssets, ...windowsAssets].toSorted());
      for (const helper of windowsAssets) {
        expect(readFileSync(helper)).toEqual(publishedHelper);
      }
      if (freebsd) {
        const stagedPackageFiles = globSync("**/*", { cwd: privateModules })
          .map((file) => path.join(privateModules, file))
          .filter((file) => lstatSync(file).isFile());
        expect(stagedPackageFiles.toSorted()).toEqual(nativeAssets.toSorted());
      }
      expect(readdirSync(directory)).toEqual(["runtime"]);
      expect(readdirSync(path.dirname(entry)).toSorted()).toEqual(
        [
          MANAGED_HANDOFF_RUNTIME_ENTRY,
          ...(freebsd ? ["node_modules"] : windows ? [helperName] : []),
        ].toSorted(),
      );
    } else {
      const base = path.join(realpathSync(directory), "literal-$HOME-`id`-'quoted'");
      mkdirSync(base, { mode: 0o700 });
      prepareNext = async () => {
        const fixture = await createPackageSwapFixture(base);
        // npm nests proc-safe and its FreeBSD addon inside the installed package.
        const nativeModules = path.join(fixture.packageRoot, "node_modules");
        if (freebsd && !existsSync(nativeModules)) {
          const procSafe = realpathSync(packageDir("@openclaw/proc-safe"));
          const platformName = `@openclaw/proc-safe-freebsd-${process.arch}`;
          const addon = path.dirname(
            createRequire(path.join(procSafe, "package.json")).resolve(
              `${platformName}/package.json`,
            ),
          );
          cpSync(procSafe, path.join(nativeModules, "@openclaw", "proc-safe"), {
            recursive: true,
          });
          cpSync(realpathSync(addon), path.join(nativeModules, platformName), {
            recursive: true,
          });
        }
        return withUpdateCommandExecutor(randomUUID(), async (executor) =>
          preparePackageActivationJournal({
            options: {
              fence: await executor.enter(fixture.packageRoot),
              runtime: packageActivationRuntimeForTest(),
              onPrepared: (command) => {
                expect(commandFacts(runCommand(command, "status"))).toMatchObject({
                  phase: "preparing",
                });
                commands.push(command);
              },
            },
            liveRoot: fixture.packageRoot,
            stageRoot: fixture.params.stage.packageRoot,
            launcherRoot: fixture.params.stage.layout.binDir,
            binDir: path.dirname(fixture.launcher),
            previous: await createPackageIntegrityReader().tree(fixture.packageRoot),
            launchers: [],
          }),
        );
      };
      const prepared = (preparedPackage = await prepareNext());
      entry = resolvePackageActivationHelper(prepared.anchor);
      expect(readdirSync(prepared.anchor).toSorted()).toEqual(
        ["candidate", "launchers"].toSorted(),
      );
    }

    // Recovery must survive loss of the old package and all its neighboring assets.
    // The POSIX activation helper intentionally has no Windows executable in custody.
    const builtRuntime = readFileSync(path.join(outDir, runtimeEntry));
    rmSync(outDir, { recursive: true });
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { isBuiltin, registerHooks, syncBuiltinESMExports } from "node:module";
          import childProcess from "node:child_process";
          import path from "node:path";
          import { fileURLToPath, pathToFileURL } from "node:url";
          import { DatabaseSync } from "node:sqlite";
          const kind = process.argv[2];
          const entryPath = process.argv[1];
          const entry = pathToFileURL(entryPath).href;
          if (kind === "package") process.argv = [process.execPath, entryPath, "--anchor", process.argv[3], "--operation", process.argv[4], "status"];
          registerHooks({ resolve(specifier, context, nextResolve) {
            if (isBuiltin(specifier) || specifier === entry) return nextResolve(specifier, context);
            assert.equal(kind, "managed", "Unexpected package recovery dependency");
            assert.equal(process.platform, "freebsd", "Unexpected native dependency");
            const resolved = nextResolve(specifier, context);
            const privateRoot = path.join(path.dirname(entryPath), "node_modules") + path.sep;
            assert(fileURLToPath(resolved.url).startsWith(privateRoot),
              "Dependency escaped private runtime: " + specifier);
            return resolved;
          } });
          const helperCalls = [];
          for (const method of ["spawn", "spawnSync"]) {
            const original = childProcess[method];
            childProcess[method] = function(file, ...args) {
              if (String(file).endsWith("windows-security-helper.exe")) helperCalls.push(String(file));
              return Reflect.apply(original, this, [file, ...args]);
            };
          }
          syncBuiltinESMExports();
          const runtime = await import(entry);
          if (kind === "managed") for (const name of [
            "assertOpenClawStateWriteAllowed",
            "resolveImmutableSqliteFileUri",
            "createManagedHandoffLeaseStore",
            "resolveUpdateRestartNoticeMeta",
            "shouldPublishUpdateRestartNotice",
          ]) {
            assert.equal(typeof runtime[name], "function", name);
          }
          if (kind === "managed") {
          if (process.platform === "win32") {
            const store = await runtime.prepareManagedHandoffLeaseStore({
              databasePath: process.argv[5], serviceManagerEnv: {},
            });
            assert.deepEqual(store.read(process.cwd()), { kind: "absent" });
            const acquired = store.acquire(process.cwd(), "fixture-owner", { kind: "update" });
            assert.equal(acquired.kind, "acquired");
            try {
              assert.equal(store.read(process.cwd()).kind, "current");
            } finally {
              assert.equal(store.release(acquired.lease), true);
            }
            assert.deepEqual(store.read(process.cwd()), { kind: "absent" });
            assert(helperCalls.length > 0, "Windows handoff did not execute the packaged ACL helper");
            assert(helperCalls.every(file => file === path.join(path.dirname(entryPath), "windows-security-helper.exe")));
            console.log("staged Windows ACL helper executed");
          }
          if (process.platform === "freebsd") {
            const options = { databasePath: path.join(process.cwd(), "identity.sqlite"), serviceManagerEnv: {} };
            const store = runtime.createManagedHandoffLeaseStore(options);
            const current = store.processIdentity(process.pid);
            assert.match(current.startIdentity, /^[0-9]+$/);
            assert.equal(store.inspectProcessIdentity(current), "live");
            const { Worker } = await import("node:worker_threads");
            const { once } = await import("node:events");
            const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(
              'import { parentPort } from "node:worker_threads"; import { createManagedHandoffLeaseStore } from ' + JSON.stringify(entry) + ';' +
              'parentPort.postMessage(createManagedHandoffLeaseStore(' + JSON.stringify(options) + ').processIdentity(process.pid));'
            )));
            try { const [observed] = await once(worker, "message"); assert.deepEqual(observed, current); }
            finally { await worker.terminate(); }
          }
          const db = new DatabaseSync(":memory:");
          try {
            db.exec(runtime.extractSqliteTableSchema(runtime.OPENCLAW_STATE_SCHEMA_SQL, "gateway_restart_sentinel", {
              endMarker: "ON gateway_restart_sentinel(ts DESC, sentinel_key);",
            }));
            db.exec("BEGIN IMMEDIATE");
            const payload = { kind: "update", status: "error", ts: 1 };
            const written = runtime.writeRestartSentinelRowIfRevisionSync(db, payload, null);
            assert(written);
            assert.deepEqual(runtime.readRestartSentinelRowSync(db), { kind: "valid", sentinel: written });
            assert.equal(runtime.writeRestartSentinelRowIfRevisionSync(db, payload, null), null);
            db.exec("COMMIT");
          } finally {
            db.close();
          }
          }
          console.log("staged production runtime loaded");
        `,
        entry,
        kind,
        preparedPackage?.anchor ?? "",
        preparedPackage?.journal.read().descriptor.operationId ?? "",
        databasePath,
      ],
      childOptions,
    );
    const output = commandOutput(result).trim();
    expect(output).toContain("staged production runtime loaded");
    if (kind === "package") {
      expect(JSON.parse(output.split("\n")[0]!)).toMatchObject({ phase: "prepared" });
      if (!preparedPackage || !prepareNext || commands.length !== 1) {
        throw new Error("First package recovery command was not published exactly once.");
      }
      const commandA = commands[0]!;
      const first = preparedPackage.journal.read();
      const firstJournal = resolvePackageActivationJournalPath(preparedPackage.anchor);
      const originalJournal = lstatSync(firstJournal);
      assertPhases(commandA, first.descriptor.operationId, [
        ["repair", "aborted"],
        ["retire", "complete"],
      ]);
      const completedJournal = readFileSync(firstJournal);
      mkdirSync(outDir);
      // A new preparation reads its own build; its detached commands still run without it.
      writeFileSync(path.join(outDir, runtimeEntry), builtRuntime);
      const second = await prepareNext();
      rmSync(outDir, { recursive: true });
      const recordB = second.journal.read();
      const journalPath = resolvePackageActivationJournalPath(second.anchor);
      const archivedJournal = path.join(
        `${second.anchor}.superseded-${first.descriptor.operationId}`,
        "control",
        "operation.sqlite",
      );
      expect(lstatSync(archivedJournal).ino).toBe(originalJournal.ino);
      expect(readFileSync(archivedJournal)).toEqual(completedJournal);
      expect(lstatSync(journalPath).ino).not.toBe(originalJournal.ino);
      expect(lstatSync(journalPath).dev).toBe(originalJournal.dev);
      expect(recordB.descriptor.operationId).not.toBe(first.descriptor.operationId);
      const snapshot = () =>
        [
          archivedJournal,
          journalPath,
          resolvePackageActivationHelper(second.anchor),
          path.join(recordB.descriptor.authority.installKey, "package.json"),
        ].map((file) => ({ bytes: readFileSync(file), ino: lstatSync(file).ino }));
      const before = snapshot();
      expect(commands).toHaveLength(2);
      for (const action of ["status", "repair", "retire"]) {
        const stale = runCommand(commandA, action);
        commandOutput(stale, 1);
        expect(stale.stderr).toContain("different operation");
        expect(snapshot()).toEqual(before);
      }
      assertPhases(commands[1]!, recordB.descriptor.operationId, [
        ["status", "prepared"],
        ["repair", "aborted"],
        ["retire", "complete"],
      ]);
    }
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
