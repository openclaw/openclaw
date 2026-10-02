import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";
import {
  createRecoverablePluginRelease,
  PluginRuntimeCloseRetainedError,
  hasRetainedPluginRuntimeCloseError,
} from "./runtime-close-error.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  const runtimeTemp = temp.make("plugin-capture-recovery-runtime-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, runtimeTemp);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createSource(): string {
  const source = temp.make("plugin-capture-recovery-input-");
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 'captured';\n");
  return source;
}

it.skipIf(process.platform === "win32")(
  "preserves replacement capture bytes after a close-then-throw",
  async () => {
    const stateDir = temp.make("plugin-capture-recovery-replacement-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = createSource();
    const open = nodeSqlite.openNodeSqliteDatabase;
    let token: ReturnType<typeof open> | undefined;
    let closeToken: (() => void) | undefined;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = open(...args);
      if (args[0].includes("owner.sqlite")) {
        token = database;
        closeToken = database.close.bind(database);
      }
      return database;
    });
    const artifact = capturePluginGenerationArtifact(source);
    const root = path.dirname(path.dirname(artifact.boundaryRoot));
    const failure = new Error("close succeeded but observer failed");
    if (!token || !closeToken) {
      throw new Error("Missing capture token");
    }
    const originalClose = closeToken;
    vi.spyOn(token, "close").mockImplementationOnce(() => {
      originalClose();
      throw failure;
    });
    let error: unknown;
    try {
      await artifact.disposeAsync();
    } catch (cause) {
      error = new PluginRuntimeCloseRetainedError(cause, {
        isReleased: artifact.isReleased,
        recover: artifact.disposeAsync,
      });
    }
    expect(error).toBeDefined();
    expect(token.isOpen).toBe(false);
    // Both the payload and its token namespace can be replaced after native close.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(artifact.boundaryRoot, { recursive: true });
    const sentinel = path.join(artifact.boundaryRoot, "operator-data");
    fs.writeFileSync(sentinel, "replacement bytes");
    const release = createRecoverablePluginRelease(async () => {
      throw error;
    });
    try {
      await release().catch(() => undefined);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("replacement bytes");
      expect(hasRetainedPluginRuntimeCloseError(error)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await artifact.disposeAsync();
    }
  },
);

it.each([false, true])("retries native-root close (async: %s)", async (asynchronous) => {
  const stateDir = temp.make("plugin-native-recovery-");
  const open = nodeSqlite.openNodeSqliteDatabase;
  let token: ReturnType<typeof open> | undefined;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0].includes("owner.sqlite")) {
      token = database;
    }
    return database;
  });
  const root = createPluginNativeCaptureRoot(stateDir, "state");
  if (!token) {
    throw new Error("Missing native capture token");
  }
  const originalClose = token.close.bind(token);
  const failure = new Error("native close unavailable");
  const close = vi.spyOn(token, "close").mockImplementation(() => {
    throw failure;
  });
  const dispose = async () => (asynchronous ? await root.disposeAsync() : root.dispose());
  try {
    await expect(dispose()).rejects.toBe(failure);
    expect(token.isOpen).toBe(true);
    expect(() => root.commit()).toThrow("disposed");
    close.mockImplementation(originalClose);
    await dispose();
    expect(token.isOpen).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
    await dispose();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    close.mockImplementation(originalClose);
    await root.disposeAsync();
    vi.restoreAllMocks();
  }
});
