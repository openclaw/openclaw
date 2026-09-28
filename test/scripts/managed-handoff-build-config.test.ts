import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../../src/cli/update-cli/update-command-executor.js";
import {
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../src/infra/package-update-activation-journal.js";
import { preparePackageActivationJournal } from "../../src/infra/package-update-activation-prepare.js";
import { packageActivationRuntimeEntrypoint } from "../../src/infra/package-update-activation-runtime-assets.js";
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

afterEach(() => vi.restoreAllMocks());

it("loads the worker compiler with native Node before preparing artifacts", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
await import("./scripts/lib/vitest-worker-compiler.mts");
console.log("native worker compiler import verified");
`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );

  expect(output.trim()).toBe("native worker compiler import verified");
});

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
  const runCommand = (command: string, action: string) =>
    spawnSync("/bin/sh", ["-c", `exec ${command.replace(/ status$/u, ` ${action}`)}`], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      cwd: directory,
      env: childEnv,
    });
  // Use the production graph unchanged, not the invocation compiler's extra plugins.
  const { bundles } = await build({ ...config, config: false, outDir, logLevel: "silent" });
  try {
    const modules = bundles.flatMap(({ chunks }) =>
      chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])),
    );
    if (kind === "managed") {
      expect(modules).toContain(
        path.resolve("src/infra/update-managed-service-handoff-native-loader.ts"),
      );
      expect(modules).not.toContain(path.resolve("src/shared/freebsd-process-identity-native.ts"));
    }
    vi.mocked(resolveRuntimeWorkerUrl).mockReturnValue(
      pathToFileURL(path.join(outDir, runtimeEntry)),
    );
    let entry: string;
    if (kind === "managed") {
      const staged = stageManagedHandoffRuntime(directory);
      entry = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
      const nativeAssets =
        process.platform === "freebsd"
          ? [
              "package.json",
              "indirect.cjs",
              "src/koffi/indirect.cjs",
              "LICENSE.txt",
              `build/koffi/freebsd_${process.arch}/koffi.node`,
            ].map((file) => path.join(directory, "runtime", "node_modules", "koffi", file))
          : [];
      expect(staged).toEqual([entry, ...nativeAssets]);
      expect(readdirSync(directory)).toEqual(["runtime"]);
      expect(readdirSync(path.dirname(entry))).toEqual(
        process.platform === "freebsd"
          ? [MANAGED_HANDOFF_RUNTIME_ENTRY, "node_modules"]
          : [MANAGED_HANDOFF_RUNTIME_ENTRY],
      );
    } else {
      const base = path.join(realpathSync(directory), "literal-$HOME-`id`-'quoted'");
      mkdirSync(base, { mode: 0o700 });
      prepareNext = async () => {
        const fixture = await createPackageSwapFixture(base);
        return withUpdateCommandExecutor(randomUUID(), async (executor) =>
          preparePackageActivationJournal({
            options: {
              fence: await executor.enter(fixture.packageRoot),
              nodeRunner: process.execPath,
              onPrepared: (command) => {
                const observed = runCommand(command, "status");
                expect(observed.error).toBeUndefined();
                expect(observed.status, observed.stderr).toBe(0);
                expect(JSON.parse(observed.stdout)).toMatchObject({ phase: "preparing" });
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

    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { isBuiltin, registerHooks } from "node:module";
          import { DatabaseSync } from "node:sqlite";
          import { pathToFileURL } from "node:url";
          const kind = process.argv[2];
          const entryPath = process.argv[1];
          const entry = pathToFileURL(entryPath).href;
          if (kind === "package") process.argv = [process.execPath, entryPath, "--anchor", process.argv[3], "--operation", process.argv[4], "status"];
          registerHooks({ resolve(specifier, context, nextResolve) {
            assert(isBuiltin(specifier) || specifier === entry,
              "Unexpected sealed runtime dependency: " + specifier);
            return nextResolve(specifier, context);
          } });
          const runtime = await import(entry);
          if (kind === "managed") for (const name of [
            "assertOpenClawStateWriteAllowed",
            "resolveImmutableSqliteFileUri",
            "createManagedHandoffLeaseStore",
            "resolveUpdateRestartNoticeMeta",
            "shouldPublishUpdateRestartNotice",
            "extractSqliteTableSchema",
            "readRestartSentinelRowSync",
            "writeRestartSentinelRowIfRevisionSync",
          ]) {
            assert.equal(typeof runtime[name], "function", name);
          }
          if (kind === "managed") {
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
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: childEnv,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toContain("staged production runtime loaded");
    if (kind === "package") {
      expect(JSON.parse(result.stdout.trim().split("\n")[0]!)).toMatchObject({
        phase: "prepared",
      });
      if (!preparedPackage || !prepareNext || commands.length !== 1) {
        throw new Error("First package recovery command was not published exactly once.");
      }
      const commandA = commands[0]!;
      const first = preparedPackage.journal.read();
      const originalJournal = lstatSync(
        resolvePackageActivationJournalPath(preparedPackage.anchor),
      );
      for (const [action, phase] of [
        ["repair", "aborted"],
        ["retire", "complete"],
      ]) {
        const recovered = runCommand(commandA, action!);
        expect(recovered.error).toBeUndefined();
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          operationId: first.descriptor.operationId,
          phase,
        });
      }
      const second = await prepareNext();
      const recordB = second.journal.read();
      const journalPath = resolvePackageActivationJournalPath(second.anchor);
      expect(lstatSync(journalPath).ino).toBe(originalJournal.ino);
      expect(lstatSync(journalPath).dev).toBe(originalJournal.dev);
      expect(recordB.revision).toBeGreaterThan(first.revision);
      expect(recordB.descriptor.operationId).not.toBe(first.descriptor.operationId);
      const snapshot = () =>
        [
          journalPath,
          resolvePackageActivationHelper(second.anchor),
          path.join(recordB.descriptor.authority.installKey, "package.json"),
        ].map((file) => ({ bytes: readFileSync(file), ino: lstatSync(file).ino }));
      const before = snapshot();
      expect(commands).toHaveLength(3);
      for (const action of ["status", "repair", "retire"]) {
        const stale = runCommand(commandA, action);
        expect(stale.error).toBeUndefined();
        expect(stale.status).toBe(1);
        expect(stale.stderr).toContain("different operation");
        const after = snapshot();
        expect(after).toHaveLength(before.length);
        for (const [index, original] of before.entries()) {
          expect(after[index]!.ino).toBe(original.ino);
          expect(after[index]!.bytes.equals(original.bytes)).toBe(true);
        }
      }
      // The replacement's temporary command is deliberately one-phase, never
      // another locator for the next operation after its helper has moved.
      expect(runCommand(commands[1]!, "status").status).not.toBe(0);
      for (const [action, phase] of [
        ["status", "prepared"],
        ["repair", "aborted"],
        ["retire", "complete"],
      ]) {
        const current = runCommand(commands[2]!, action!);
        expect(current.error).toBeUndefined();
        expect(current.status, current.stderr).toBe(0);
        expect(JSON.parse(current.stdout)).toMatchObject({
          operationId: recordB.descriptor.operationId,
          phase,
        });
      }
    }
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
