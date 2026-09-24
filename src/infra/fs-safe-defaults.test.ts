// Covers native selection at the real process configuration boundary.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nativeProcessTestEntrypoints } from "./native-process-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const defaultsUrl = resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.fsSafeDefaults);
const memoryUrl = resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.memoryFsUtils);

type NativeMode = "auto" | "off" | "require";

function inspectNativeDefaults(params: {
  env?: Record<string, string>;
  beforeImport?: NativeMode;
  afterImport?: NativeMode;
}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:OPENCLAW_)?FS_SAFE_(?:NATIVE|PYTHON)(?:_MODE)?$/iu.test(key) ||
      /^OPENCLAW_PINNED_(?:WRITE_)?PYTHON$/iu.test(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, params.env);
  const output = execFileSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(defaultsUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `
      const options = JSON.parse(process.argv[1]);
      const config = await import("@openclaw/fs-safe/config");
      if (options.beforeImport) config.configureFsSafeNative({ mode: options.beforeImport });
      await import(options.defaultsUrl);
      await import(options.memoryUrl);
      const before = config.getFsSafeNativeConfig().mode;
      if (options.afterImport) config.configureFsSafeNative({ mode: options.afterImport });
      const after = config.getFsSafeNativeConfig().mode;
      process.stdout.write(JSON.stringify({ before, after }));
    `,
      JSON.stringify({
        ...params,
        defaultsUrl: defaultsUrl.href,
        memoryUrl: memoryUrl.href,
      }),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  return JSON.parse(output) as {
    before: NativeMode;
    after: NativeMode;
  };
}

describe("fs-safe defaults", () => {
  it("retains upstream auto after core and memory filesystem imports", () => {
    expect(inspectNativeDefaults({})).toEqual({ before: "auto", after: "auto" });
  });

  it.each(["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"])(
    "honors explicit modes through %s",
    (key) => {
      for (const mode of ["off", "auto", "require"] as const) {
        expect(inspectNativeDefaults({ env: { [key]: mode } })).toEqual({
          before: mode,
          after: mode,
        });
      }
    },
  );

  it("preserves library precedence between environment aliases", () => {
    expect(
      inspectNativeDefaults({
        env: {
          FS_SAFE_NATIVE_MODE: "off",
          OPENCLAW_FS_SAFE_NATIVE_MODE: "require",
        },
      }),
    ).toEqual({ before: "off", after: "off" });
  });

  it.each(["off", "require"] as const)(
    "preserves programmatic %s configured before import",
    (mode) => {
      expect(inspectNativeDefaults({ beforeImport: mode })).toEqual({ before: mode, after: mode });
    },
  );

  it("retains later programmatic configuration over an environment mode", () => {
    expect(
      inspectNativeDefaults({ env: { FS_SAFE_NATIVE_MODE: "off" }, afterImport: "require" }),
    ).toEqual({ before: "off", after: "require" });
  });

  it("retains legacy mode migration without overriding it", () => {
    expect(inspectNativeDefaults({ env: { OPENCLAW_FS_SAFE_PYTHON_MODE: "require" } })).toEqual({
      before: "require",
      after: "require",
    });
  });

  it.skipIf(process.platform !== "win32")(
    "honors case-insensitive Windows environment names",
    () => {
      expect(inspectNativeDefaults({ env: { openclaw_fs_safe_native_mode: "require" } })).toEqual({
        before: "require",
        after: "require",
      });
    },
  );
});
