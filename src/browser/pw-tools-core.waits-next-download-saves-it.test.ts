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
  resolvePreferredActiviTmpDir: vi.fn(() => "/tmp/activi"),
}));
vi.mock("../infra/tmp-activi-dir.js", () => tmpDirMocks);
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core", () => {
  beforeEach(() => {
    for (const fn of Object.values(tmpDirMocks)) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredActiviTmpDir.mockReturnValue("/tmp/activi");
  });

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

  it("waits for the next download and saves it", async () => {
    const harness = createDownloadEventHarness();

    const saveAs = vi.fn(async () => {});
    const download = {
      url: () => "https://example.com/file.bin",
      suggestedFilename: () => "file.bin",
      saveAs,
    };

    const targetPath = path.resolve("/tmp/file.bin");
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
    expect(saveAs).toHaveBeenCalledWith(targetPath);
    expect(res.path).toBe(targetPath);
  });
  it("clicks a ref and saves the resulting download", async () => {
    const harness = createDownloadEventHarness();

    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ click });

    const saveAs = vi.fn(async () => {});
    const download = {
      url: () => "https://example.com/report.pdf",
      suggestedFilename: () => "report.pdf",
      saveAs,
    };

    const targetPath = path.resolve("/tmp/report.pdf");
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
    expect(saveAs).toHaveBeenCalledWith(targetPath);
    expect(res.path).toBe(targetPath);
  });
  it("uses preferred tmp dir when waiting for download without explicit path", async () => {
    tmpDirMocks.resolvePreferredActiviTmpDir.mockReturnValue("/tmp/activi-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/file.bin",
      suggestedFilename: "file.bin",
    });
    expect(typeof outPath).toBe("string");
    const expectedRootedDownloadsDir = path.join(
      path.sep,
      "tmp",
      "activi-preferred",
      "downloads",
    );
    const expectedDownloadsTail = `${path.join("tmp", "activi-preferred", "downloads")}${path.sep}`;
    expect(path.dirname(String(outPath))).toBe(expectedRootedDownloadsDir);
    expect(path.basename(String(outPath))).toMatch(/-file\.bin$/);
    expect(path.normalize(res.path)).toContain(path.normalize(expectedDownloadsTail));
    expect(tmpDirMocks.resolvePreferredActiviTmpDir).toHaveBeenCalled();
  });

  it("sanitizes suggested download filenames to prevent traversal escapes", async () => {
    tmpDirMocks.resolvePreferredActiviTmpDir.mockReturnValue("/tmp/activi-preferred");
    const { res, outPath } = await waitForImplicitDownloadOutput({
      downloadUrl: "https://example.com/evil",
      suggestedFilename: "../../../../etc/passwd",
    });
    expect(typeof outPath).toBe("string");
    expect(path.dirname(String(outPath))).toBe(
      path.join(path.sep, "tmp", "activi-preferred", "downloads"),
    );
    expect(path.basename(String(outPath))).toMatch(/-passwd$/);
    expect(path.normalize(res.path)).toContain(
      path.normalize(`${path.join("tmp", "activi-preferred", "downloads")}${path.sep}`),
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
