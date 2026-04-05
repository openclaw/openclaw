import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

type LoggerModule = typeof import("./logger.js");

const originalGetBuiltinModule = (
  process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule;

async function importBrowserSafeLogger(params?: {
  resolvePreferredMullusiTmpDir?: ReturnType<typeof vi.fn>;
}): Promise<{
  module: LoggerModule;
  resolvePreferredMullusiTmpDir: ReturnType<typeof vi.fn>;
}> {
  const resolvePreferredMullusiTmpDir =
    params?.resolvePreferredMullusiTmpDir ??
    vi.fn(() => {
      throw new Error("resolvePreferredMullusiTmpDir should not run during browser-safe import");
    });

  vi.doMock("../infra/tmp-mullusi-dir.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/tmp-mullusi-dir.js")>(
      "../infra/tmp-mullusi-dir.js",
    );
    return {
      ...actual,
      resolvePreferredMullusiTmpDir,
    };
  });

  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    value: undefined,
  });

  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    "./logger.js?scope=browser-safe",
  );
  return { module, resolvePreferredMullusiTmpDir };
}

describe("logging/logger browser-safe import", () => {
  afterEach(() => {
    vi.doUnmock("../infra/tmp-mullusi-dir.js");
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      value: originalGetBuiltinModule,
    });
  });

  it("does not resolve the preferred temp dir at import time when node fs is unavailable", async () => {
    const { module, resolvePreferredMullusiTmpDir } = await importBrowserSafeLogger();

    expect(resolvePreferredMullusiTmpDir).not.toHaveBeenCalled();
    expect(module.DEFAULT_LOG_DIR).toBe("/tmp/mullusi");
    expect(module.DEFAULT_LOG_FILE).toBe("/tmp/mullusi/mullusi.log");
  });

  it("disables file logging when imported in a browser-like environment", async () => {
    const { module, resolvePreferredMullusiTmpDir } = await importBrowserSafeLogger();

    expect(module.getResolvedLoggerSettings()).toMatchObject({
      level: "silent",
      file: "/tmp/mullusi/mullusi.log",
    });
    expect(module.isFileLogLevelEnabled("info")).toBe(false);
    expect(() => module.getLogger().info("browser-safe")).not.toThrow();
    expect(resolvePreferredMullusiTmpDir).not.toHaveBeenCalled();
  });
});
