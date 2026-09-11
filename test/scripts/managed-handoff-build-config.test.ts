import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../../src/cli/update-cli/update-command-executor.js";
import { preparePackageActivationJournal } from "../../src/infra/package-update-activation-prepare.js";
import {
  PACKAGE_ACTIVATION_HELPER,
  packageActivationRuntimeEntrypoint,
} from "../../src/infra/package-update-activation-runtime-assets.js";
import { createPackageIntegrityReader } from "../../src/infra/package-update-integrity.js";
import { createPackageSwapFixture } from "../../src/infra/package-update-swap.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import * as tempRoot from "../../src/infra/tmp-openclaw-dir.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../src/infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../src/infra/update-managed-service-handoff-runtime.js";
import buildConfigs from "../../tsdown.config.ts";
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

vi.mock("../../src/infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: vi.fn(),
}));

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
  const outDir = tempDirs.make("openclaw-handoff-build-");
  const directory = tempDirs.make("openclaw-handoff-stage-");
  // Use the production graph unchanged, not the invocation compiler's extra plugins.
  const bundles = await build({ ...config, config: false, outDir, logLevel: "silent" });
  try {
    vi.mocked(resolveRuntimeWorkerUrl).mockReturnValue(
      pathToFileURL(path.join(outDir, runtimeEntry)),
    );
    let entry: string;
    if (kind === "managed") {
      const staged = stageManagedHandoffRuntime(directory);
      entry = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
      expect(staged).toEqual([entry]);
      expect(readdirSync(directory)).toEqual(["runtime"]);
      expect(readdirSync(path.dirname(entry))).toEqual([MANAGED_HANDOFF_RUNTIME_ENTRY]);
    } else {
      const base = realpathSync(directory);
      const control = path.join(base, "authority");
      mkdirSync(control, { mode: 0o700 });
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const fixture = await createPackageSwapFixture(base);
      const prepared = await withUpdateCommandExecutor(randomUUID(), async (executor) =>
        preparePackageActivationJournal({
          options: {
            fence: await executor.enter(fixture.packageRoot),
            nodeRunner: process.execPath,
            onPrepared: () => {},
          },
          liveRoot: fixture.packageRoot,
          stageRoot: fixture.params.stage.packageRoot,
          launcherRoot: fixture.params.stage.layout.binDir,
          binDir: path.dirname(fixture.launcher),
          previous: await createPackageIntegrityReader().tree(fixture.packageRoot),
          launchers: [],
        }),
      );
      entry = path.join(prepared.anchor, PACKAGE_ACTIVATION_HELPER);
      expect(readdirSync(prepared.anchor).toSorted()).toEqual(
        ["candidate", "launchers", "operation.sqlite", PACKAGE_ACTIVATION_HELPER].toSorted(),
      );
    }

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { isBuiltin, registerHooks } from "node:module";
          import { pathToFileURL } from "node:url";
          const kind = process.argv[2];
          const entryPath = process.argv[1];
          const entry = pathToFileURL(entryPath).href;
          if (kind === "package") process.argv = [process.execPath, entryPath, "status"];
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
            "hasManagedUpdateRecoveryRecord",
            "resolveUpdateRestartNoticeMeta",
            "shouldPublishUpdateRestartNotice",
          ]) {
            assert.equal(typeof runtime[name], "function", name);
          }
          console.log("staged production runtime loaded");
        `,
        entry,
        kind,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          HOME: directory,
          USERPROFILE: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toContain("staged production runtime loaded");
    if (kind === "package") {
      expect(JSON.parse(result.stdout.trim().split("\n")[0]!)).toMatchObject({
        phase: "prepared",
      });
    }
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
