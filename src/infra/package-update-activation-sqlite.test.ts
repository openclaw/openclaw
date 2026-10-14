import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import { openPackageActivationJournal } from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { capturePackageActivationRuntime } from "./package-update-activation-paths.js";
import {
  assertPackageActivationRecoveryRuntime,
  sealPackageActivationSqliteLibrary,
} from "./package-update-activation-sqlite.js";
import { readPackageActivationReceipt } from "./package-update-activation.js";
import * as runtimeGuard from "./runtime-guard.js";

const fixture = createPackageActivationLifetimeFixture();
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it
  .skipIf(process.platform === "win32")
  .each(["OPENCLAW_SQLITE_LIBRARY", "HOMEBREW_PREFIX"] as const)(
  "retains admitted %s selection in the helper and clean-shell receipt command",
  async (key) => {
    const { root, childGuardEnv } = fixture.setup();
    const library = path.join(root, "operator's custom $sqlite", "libsqlite3.dylib");
    const env = { [key]: key === "OPENCLAW_SQLITE_LIBRARY" ? library : root };
    const probe = vi
      .spyOn(runtimePaths, "resolveBunRuntimeInfo")
      .mockImplementation(async (_runtime, _exec, actualEnv) => ({
        status: actualEnv?.[key] === env[key] ? "supported" : "unsupported",
        version: "1.4.3",
        sqliteVersion: "3.53.4",
        sqliteLibraryPath: library,
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        nodeSharedSqlite: false,
      }));
    // The delivery helper exposes the environment actually seen by the new process.
    fs.writeFileSync(
      path.join(root, "sealed.mjs"),
      "console.log(JSON.stringify({library:process.env.OPENCLAW_SQLITE_LIBRARY,args:process.argv.slice(2)}));\n",
    );
    const runtime = { ...capturePackageActivationRuntime("bun", process.execPath), env };
    const prepared = await fixture.prepare(undefined, undefined, runtime);
    expect(probe).toHaveBeenCalledWith(runtime.path, undefined, env);
    const descriptor = openPackageActivationJournal(prepared.anchor).read().descriptor;
    expect(descriptor.version).toBe(1);
    expect(descriptor).not.toHaveProperty("sqliteLibraryPath");
    expect(descriptor).not.toHaveProperty("env");
    const command = readPackageActivationReceipt(prepared.packageRoot)?.recoveryCommand;
    expect(command).toMatch(/^OPENCLAW_SQLITE_LIBRARY=/);
    expect(command).toContain(`OPENCLAW_SQLITE_LIBRARY=${quoteCliArg(library)} `);
    const result = spawnSync("/bin/sh", ["-c", command!], {
      env: childGuardEnv({}),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      library,
      args: ["--anchor", prepared.anchor, "--operation", prepared.operationId, "status"],
    });
    // The old empty-environment admission loses the supported selection before custody.
    await expect(fixture.prepare(undefined, undefined, { ...runtime, env: {} })).rejects.toThrow(
      "supported external Bun executable",
    );
  },
);

it("refuses unsafe recovery discovery with the exact retained library input", async () => {
  const { root } = fixture.setup();
  const library = path.join(root, "custom SQLite", "libsqlite3.dylib");
  const helper = path.join(root, "sealed.mjs");
  fs.writeFileSync(helper, sealPackageActivationSqliteLibrary(Buffer.from("// helper\n"), library));
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    versions: { ...process.versions, bun: "1.4.3" },
    env: {},
  });
  const probe = vi.spyOn(runtimeGuard, "isCurrentRuntimeSupported").mockResolvedValue(false);
  await expect(assertPackageActivationRecoveryRuntime(helper)).rejects.toThrow(
    `Retry with OPENCLAW_SQLITE_LIBRARY=${quoteCliArg(library)}.`,
  );
  expect(probe).toHaveBeenCalledOnce();
  expect(process.env).toEqual({});
});
