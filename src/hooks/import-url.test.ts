import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildImportUrl } from "./import-url.js";

describe("buildImportUrl", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let fixtureRoot: string;
  let immutableHandlerPath: string;

  beforeAll(() => {
    fixtureRoot = tempDirs.make("import-url-test-");
    immutableHandlerPath = path.join(fixtureRoot, "handler.js");
    fs.writeFileSync(immutableHandlerPath, "export default () => {};");
  });

  it("reloads a workspace hook after a same-size edit with restored mtime", async () => {
    const tmpFile = path.join(fixtureRoot, "reload-handler.js");
    const initialSource = 'export default () => "before";\n';
    const editedSource = 'export default () => "after!";\n';
    expect(Buffer.byteLength(editedSource)).toBe(Buffer.byteLength(initialSource));

    fs.writeFileSync(tmpFile, initialSource);
    const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(tmpFile, cleanTime, cleanTime);
    const initialStat = fs.statSync(tmpFile);
    const initialUrl = buildImportUrl(tmpFile, "openclaw-workspace");
    const initialHandler = (await import(/* @vite-ignore */ initialUrl)).default as () => string;
    expect(initialHandler()).toBe("before");

    await vi.waitFor(
      () => {
        fs.writeFileSync(tmpFile, editedSource);
        fs.utimesSync(tmpFile, initialStat.atime, initialStat.mtime);
        expect(fs.statSync(tmpFile).ctimeMs).not.toBe(initialStat.ctimeMs);
      },
      { interval: 1, timeout: 1_000 },
    );

    const editedStat = fs.statSync(tmpFile);
    expect(editedStat.size).toBe(initialStat.size);
    expect(editedStat.mtimeMs).toBe(initialStat.mtimeMs);
    const editedUrl = buildImportUrl(tmpFile, "openclaw-workspace");
    const editedHandler = (await import(/* @vite-ignore */ editedUrl)).default as () => string;
    expect(editedHandler()).toBe("after!");
  });

  it("falls back to Date.now() when file does not exist", () => {
    const url = buildImportUrl(path.join(fixtureRoot, "missing-handler.js"), "openclaw-workspace");
    expect(url).toMatch(/\?t=\d+/);
  });
});
