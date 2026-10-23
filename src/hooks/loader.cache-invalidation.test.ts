import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as boundaryFile from "../infra/boundary-file-read.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  setInternalHooksEnabled,
  triggerInternalHook,
} from "./internal-hooks.js";
import { prepareInternalHooks } from "./loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("loaded hook import freshness", () => {
  let workspaceDir: string;
  let handlerPath: string;
  const config: OpenClawConfig = {
    hooks: { internal: { enabled: true, entries: { "reload-hook": { enabled: true } } } },
  };
  const source = (value: string) =>
    "export default async function(event) { event.messages.push(" +
    JSON.stringify(value) +
    "); }\n";

  beforeEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    workspaceDir = tempDirs.make("openclaw-hook-import-freshness-");
    const hookDir = path.join(workspaceDir, "hooks", "reload-hook");
    handlerPath = path.join(hookDir, "handler.js");
    writeHookFixture(
      hookDir,
      '---\nname: reload-hook\ndescription: reload fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
      source("before"),
      "handler.js",
    );
  });

  afterEach(() => {
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    clearInternalHooks();
    setInternalHooksEnabled(true);
    vi.restoreAllMocks();
  });

  async function loadAndExpect(message: string) {
    const prepared = await prepareInternalHooks(config, workspaceDir);
    expect(prepared.loadedCount).toBe(1);
    prepared.commit();
    const event = createInternalHookEvent("command", "new", "freshness-session");
    await triggerInternalHook(event);
    expect(event.messages).toEqual([message]);
  }

  it("reloads a same-size workspace handler whose mtime was restored", async () => {
    const initialSource = source("before");
    const editedSource = source("after!");
    expect(Buffer.byteLength(editedSource)).toBe(Buffer.byteLength(initialSource));
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(handlerPath, cleanTime, cleanTime);
    const initialStat = fs.statSync(handlerPath);
    await loadAndExpect("before");

    await vi.waitFor(
      () => {
        fs.writeFileSync(handlerPath, editedSource);
        fs.utimesSync(handlerPath, initialStat.atime, initialStat.mtime);
        expect(fs.statSync(handlerPath).ctimeMs).not.toBe(initialStat.ctimeMs);
      },
      { interval: 1, timeout: 1_000 },
    );
    const editedStat = fs.statSync(handlerPath);
    expect(editedStat.size).toBe(initialStat.size);
    expect(editedStat.mtimeMs).toBe(initialStat.mtimeMs);
    await loadAndExpect("after!");
  });

  it("reloads when metadata stat fails after the handler passes file admission", async () => {
    const realOpenRootFile = boundaryFile.openRootFile;
    const failedMetadataPaths: string[] = [];
    const admittedPaths: string[] = [];
    vi.spyOn(boundaryFile, "openRootFile").mockImplementation(async (params) => {
      const opened = await realOpenRootFile(params);
      if (opened.ok) {
        admittedPaths.push(opened.path);
        vi.spyOn(fs, "statSync").mockImplementationOnce((name) => {
          failedMetadataPaths.push(String(name));
          throw new Error("fixture metadata unavailable");
        });
      }
      return opened;
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    await loadAndExpect("before");
    fs.writeFileSync(handlerPath, source("after!"));
    clock.mockReturnValue(200);
    await loadAndExpect("after!");
    expect(failedMetadataPaths).toEqual(admittedPaths);
    expect(failedMetadataPaths).toHaveLength(2);
  });
});
