import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

// Spy on replaceFileAtomic so we can verify that fsync flags are forwarded.
// We delegate to the real implementation so the test still exercises the
// actual write path and resulting file.
const replaceFileAtomicSpy = vi.hoisted(() =>
  vi.fn<
    [import("../infra/replace-file.js").ReplaceFileAtomicOptions],
    ReturnType<typeof import("../infra/replace-file.js").replaceFileAtomic>
  >(),
);
const replaceFileAtomicSyncSpy = vi.hoisted(() =>
  vi.fn<
    [import("../infra/replace-file.js").ReplaceFileAtomicSyncOptions],
    ReturnType<typeof import("../infra/replace-file.js").replaceFileAtomicSync>
  >(),
);

vi.mock("../infra/replace-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/replace-file.js")>();
  return {
    ...actual,
    replaceFileAtomic: (options: import("../infra/replace-file.js").ReplaceFileAtomicOptions) => {
      replaceFileAtomicSpy(options);
      return actual.replaceFileAtomic(options);
    },
    replaceFileAtomicSync: (
      options: import("../infra/replace-file.js").ReplaceFileAtomicSyncOptions,
    ) => {
      replaceFileAtomicSyncSpy(options);
      return actual.replaceFileAtomicSync(options);
    },
  };
});

// Imported after the mock is registered so the module picks up the wrapped
// helpers from the mock above.
const { createConfigIO, resetConfigRuntimeState } = await import("./io.js");

describe("config writers enable fsync", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-config-fsync-",
  });
  const silentLogger = { warn: () => {}, error: () => {} };

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  afterEach(() => {
    resetConfigRuntimeState();
    replaceFileAtomicSpy.mockClear();
    replaceFileAtomicSyncSpy.mockClear();
  });

  it("writeConfigFile forwards syncTempFile and syncParentDir to replaceFileAtomic", async () => {
    const home = await suiteRootTracker.make("write-config");
    const io = createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

    await io.writeConfigFile({ gateway: { mode: "local", port: 18789 } });

    // Find the call that targeted the main config file. Other write paths
    // (health state, plugin install index) may also call replaceFileAtomic
    // and are not in scope for this assertion.
    const configCall = replaceFileAtomicSpy.mock.calls.find(([options]) =>
      options.filePath.endsWith(path.join(".openclaw", "openclaw.json")),
    );

    expect(
      configCall,
      "expected replaceFileAtomic to be invoked for openclaw.json",
    ).toBeDefined();
    expect(configCall?.[0].syncTempFile).toBe(true);
    expect(configCall?.[0].syncParentDir).toBe(true);

    // Sanity check: the file actually landed on disk.
    const written = await fs.readFile(
      path.join(home, ".openclaw", "openclaw.json"),
      "utf-8",
    );
    expect(written).toContain('"port"');
  });
});
