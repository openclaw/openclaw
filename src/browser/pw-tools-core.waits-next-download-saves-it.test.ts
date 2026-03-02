import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const sessionMocks = getPwToolsCoreSessionMocks();
const tmpDirMocks = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => tmpDirMocks);
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core", () => {
  beforeEach(() => {
    for (const fn of Object.values(tmpDirMocks)) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  async function withTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-download-test-"));
    try {
      return await run(tempDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function waitForImplicitDownloadOutput(params: {
    downloadUrl: string;
    suggestedFilename: string;
  }) {
    const harness = createDownloadEventHarness();
    const saveAs = vi.fn(async () => {});

    const p = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });

    await Promise.resolve();
    harness.trigger({
      url: () => params.downloadUrl,
      suggestedFilename: () => params.suggestedFilename,
      saveAs,
    });

    const res = await p;
    const outPath = (vi.mocked(saveAs).mock.calls as unknown as Array<[string]>)[0]?.[0];
    return { res, outPath };
  }

  function createDownloadEventHarness() {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });
    return {
      trigger: (download: unknown) => {
        downloadHandler?.(download);
      },
      expectArmed: () => {
        expect(downloadHandler).toBeDefined();
      },
    };
  }

  async function expectAtomicDownloadSave(params: {
    saveAs: ReturnType<typeof vi.fn>;
    targetPath: string;
    tempDir: string;
    content: string;
  }) {
    const savedPath = params.saveAs.mock.calls[0]?.[0];
    expect(typeof savedPath).toBe("string");
    expect(savedPath).not.toBe(params.targetPath);
    expect(path.dirname(String(savedPath))).toBe(params.tempDir);
    expect(path.basename(String(savedPath))).toContain(".openclaw-output-");
    expect(path.basename(String(savedPath))).toContain(".part");
    expect(await fs.readFile(params.targetPath, "utf8")).toBe(params.content);
  }

  it("waits for the next download and atomically finalizes explicit output paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();
      const targetPath = path.join(tempDir, "file.bin");

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "file-content", "utf8");
      });
      const download = {
        url: () => "https://example.com/file.bin",
        suggestedFilename: () => "file.bin",
        saveAs,
      };

      const p = mod.waitForDownloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      harness.trigger(download);

      const res = await p;
      await expectAtomicDownloadSave({ saveAs, targetPath, tempDir, content: "file-content" });
      expect(res.path).toBe(targetPath);
    });
  });
  it("clicks a ref and atomically finalizes explicit download paths", async () => {
    await withTempDir(async (tempDir) => {
      const harness = createDownloadEventHarness();

      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ click });

      const saveAs = vi.fn(async (outPath: string) => {
        await fs.writeFile(outPath, "report-content", "utf8");
      });
      const download = {
        url: () => "https://example.com/report.pdf",
        suggestedFilename: () => "report.pdf",
        saveAs,
      };

      const targetPath = path.join(tempDir, "report.pdf");
      const p = mod.downloadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "e12",
        path: targetPath,
        timeoutMs: 1000,
      });

      await Promise.resolve();
      harness.expectArmed();
      expect(click).toHaveBeenCalledWith({ timeout: 1000 });

      harness.trigger(download);

      const res = await p;
      await expectAtomicDownloadSave({ saveAs, targetPath, tempDir, content: "report-content" });
      expect(res.path).toBe(targetPath);
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not overwrite outside files when explicit output path is a hardlink alias",
    async () => {
      await withTempDir(async (tempDir) => {
        const outsidePath = path.join(tempDir, "outside.txt");
        await fs.writeFile(outsidePath, "outside-before", "utf8");
        const linkedPath = path.join(tempDir, "linked.txt");
        await fs.link(outsidePath, linkedPath);

        const harness = createDownloadEventHarness();
        const saveAs = vi.fn(async (outPath: string) => {
          await fs.writeFile(outPath, "download-content", "utf8");
        });
        const p = mod.waitForDownloadViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          path: linkedPath,
          timeoutMs: 1000,
        });

        await Promise.resolve();
        harness.expectArmed();
        harness.trigger({
          url: () => "https://example.com/file.bin",
          suggestedFilename: () => "file.bin",
          saveAs,
        });

        const res = await p;
        expect(res.path).toBe(linkedPath);
        expect(await fs.readFile(linkedPath, "utf8")).toBe("download-content");
        expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-before");
      });
    },
  );

  it("uses preferred tmp dir when waiting for download without explicit path", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/file.bin",
      suggestedFilename: "file.bin",
    });
    expect(typeof outPath).toBe("string");
    const expectedRootedDownloadsDir = path.resolve(
      path.join(path.sep, "tmp", "openclaw-preferred", "downloads"),
    );
    const expectedDownloadsTail = `${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`;
    expect(path.dirname(String(outPath))).toBe(expectedRootedDownloadsDir);
    expect(path.basename(String(outPath))).toMatch(/-file\.bin$/);
    expect(path.normalize(res.path)).toContain(path.normalize(expectedDownloadsTail));
    expect(tmpDirMocks.resolvePreferredOpenClawTmpDir).toHaveBeenCalled();
  });

  it("sanitizes suggested download filenames to prevent traversal escapes", async () => {
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/evil",
      suggestedFilename: "../../../../etc/passwd",
    });
    expect(typeof outPath).toBe("string");
    expect(path.dirname(String(outPath))).toBe(
      path.resolve(path.join(path.sep, "tmp", "openclaw-preferred", "downloads")),
    );
    expect(path.basename(String(outPath))).toMatch(/-passwd$/);
    expect(path.normalize(res.path)).toContain(
      path.normalize(`${path.join("tmp", "openclaw-preferred", "downloads")}${path.sep}`),
    );
  });
  it("waits for a matching response and returns its body", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    setPwToolsCoreCurrentPage({ on, off });

    const resp = {
      url: () => "https://example.com/api/data",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      text: async () => '{"ok":true,"value":123}',
    };

    const p = mod.responseBodyViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      url: "**/api/data",
      timeoutMs: 1000,
      maxChars: 10,
    });

    await Promise.resolve();
    expect(responseHandler).toBeDefined();
    responseHandler?.(resp);

    const res = await p;
    expect(res.url).toBe("https://example.com/api/data");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true');
    expect(res.truncated).toBe(true);
  });
  it("scrolls a ref into view (default timeout)", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    const page = {};
    setPwToolsCoreCurrentPage(page);

    await mod.scrollIntoViewViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
    });

    expect(sessionMocks.refLocator).toHaveBeenCalledWith(page, "1");
    expect(scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 20_000 });
  });
  it("requires a ref for scrollIntoView", async () => {
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded: vi.fn(async () => {}) });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "   ",
      }),
    ).rejects.toThrow(/ref is required/i);
  });
});
