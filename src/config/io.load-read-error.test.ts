import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

it.each(["sync", "async"] as const)(
  "reports an inaccessible %s config instead of loading fresh-install defaults",
  async (mode) => {
    const home = dirs.make("openclaw-config-load-error-");
    const configPath = path.join(home, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", port: 19001 } }));
    const logger = { warn: vi.fn(), error: vi.fn() };
    const io = createConfigIO({
      env: { HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") },
      homedir: () => home,
      configPath,
      observe: false,
      pluginValidation: "core-only",
      logger,
    });
    const failure = Object.assign(new Error("synthetic config permission denied"), {
      code: "EACCES",
    });
    const exists = fs.existsSync;
    const access = fs.promises.access;
    const read = fs.readFileSync;
    const readAsync = fs.promises.readFile;
    vi.spyOn(fs, "existsSync").mockImplementation((file) =>
      file === configPath ? false : exists(file),
    );
    vi.spyOn(fs.promises, "access").mockImplementation(async (file, accessMode) => {
      if (file === configPath) {
        throw failure;
      }
      return access(file, accessMode);
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((file, encoding) => {
      if (file === configPath) {
        throw failure;
      }
      return read(file, encoding);
    });
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (file, encoding) => {
      if (file === configPath) {
        throw failure;
      }
      return readAsync(file, encoding);
    });
    if (mode === "sync") {
      expect(() => io.loadConfig()).toThrow(failure);
    } else {
      await expect(io.loadConfigAsync()).rejects.toBe(failure);
    }
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  },
);
