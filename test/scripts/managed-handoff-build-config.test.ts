import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../src/infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../src/infra/update-managed-service-handoff-runtime.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads the staged production handoff runtime without neighboring SQL or JSON assets", async () => {
  const entryName = MANAGED_HANDOFF_RUNTIME_ENTRY.replace(/\.mjs$/u, "");
  const config = buildConfigs.find(
    ({ entry }) => typeof entry === "object" && entry !== null && Object.hasOwn(entry, entryName),
  );
  if (!config) {
    throw new Error("Missing production managed handoff build config");
  }
  const outDir = tempDirs.make("openclaw-handoff-build-");
  const directory = tempDirs.make("openclaw-handoff-stage-");
  // Use the production graph unchanged, not the invocation compiler's extra plugins.
  const { bundles } = await build({ ...config, config: false, outDir, logLevel: "silent" });
  try {
    const modules = bundles.flatMap(({ chunks }) =>
      chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : [])),
    );
    expect(modules).toContain(
      path.resolve("src/infra/update-managed-service-handoff-native-loader.ts"),
    );
    expect(modules).not.toContain(path.resolve("src/shared/freebsd-process-identity-native.ts"));
    vi.mocked(resolveRuntimeWorkerUrl).mockReturnValue(
      pathToFileURL(path.join(outDir, MANAGED_HANDOFF_RUNTIME_ENTRY)),
    );
    const staged = stageManagedHandoffRuntime(directory);
    const entry = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
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
          const entry = pathToFileURL(process.argv[1]).href;
          registerHooks({ resolve(specifier, context, nextResolve) {
            assert(isBuiltin(specifier) || specifier === entry,
              "Unexpected sealed runtime dependency: " + specifier);
            return nextResolve(specifier, context);
          } });
          const runtime = await import(entry);
          for (const name of [
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
          console.log("staged production handoff runtime loaded");
        `,
        entry,
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
    expect(result.stdout.trim()).toBe("staged production handoff runtime loaded");
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
