import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
};

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) {
      throw new Error("missing locator");
    }
    return currentRefLocator;
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", () => sessionMocks);
const tmpDirMocks = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => tmpDirMocks);

async function importModule() {
  return await import("./pw-tools-core.js");
}

describe("pw-tools-core", () => {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
    };
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(tmpDirMocks)) {
      fn.mockClear();
    }
    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw");
  });

  it("waits for the next download and saves it", async () => {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandler = handler;
      }
    });
    const off = vi.fn();

    const saveAs = vi.fn(async () => {});
    const download = {
      url: () => "https://example.com/file.bin",
      suggestedFilename: () => "file.bin",
      saveAs,
    };

    currentPage = { on, off };

    const mod = await importModule();
    const targetPath = path.resolve("/tmp/file.bin");
    const p = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      path: targetPath,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(downloadHandler).toBeDefined();
    downloadHandler?.(download);

    const res = await p;
    expect(saveAs).toHaveBeenCalledWith(targetPath);
    expect(res.path).toBe(targetPath);
  });
  it("clicks a ref and saves the resulting download", async () => {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandler = handler;
      }
    });
    const off = vi.fn();

    const click = vi.fn(async () => {});
    currentRefLocator = { click };

    const saveAs = vi.fn(async () => {});
    const download = {
      url: () => "https://example.com/report.pdf",
      suggestedFilename: () => "report.pdf",
      saveAs,
    };

    currentPage = { on, off };

    const mod = await importModule();
    const targetPath = path.resolve("/tmp/report.pdf");
    const p = mod.downloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e12",
      path: targetPath,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(downloadHandler).toBeDefined();
    expect(click).toHaveBeenCalledWith({ timeout: 1000 });

    downloadHandler?.(download);

    const res = await p;
    expect(saveAs).toHaveBeenCalledWith(targetPath);
    expect(res.path).toBe(targetPath);
  });
  it("uses preferred tmp dir when waiting for download without explicit path", async () => {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (download: unknown) => void) => {
      if (event === "download") {
        downloadHandler = handler;
      }
    });
    const off = vi.fn();

    const saveAs = vi.fn(async () => {});
    const download = {
      url: () => "https://example.com/file.bin",
      suggestedFilename: () => "file.bin",
      saveAs,
    };

    tmpDirMocks.resolvePreferredOpenClawTmpDir.mockReturnValue("/tmp/openclaw-preferred");
    currentPage = { on, off };

    const mod = await importModule();
    const p = mod.waitForDownloadViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      timeoutMs: 1000,
    });

    await Promise.resolve();
    downloadHandler?.(download);

    const res = await p;
    const outPath = vi.mocked(saveAs).mock.calls[0]?.[0];
    expect(typeof outPath).toBe("string");
    expect(String(outPath)).toContain("/tmp/openclaw-preferred/downloads/");
    expect(String(outPath)).toContain("-file.bin");
    expect(res.path).toContain("/tmp/openclaw-preferred/downloads/");
    expect(tmpDirMocks.resolvePreferredOpenClawTmpDir).toHaveBeenCalled();
  });
  it("waits for a matching response and returns its body", async () => {
    let responseHandler: ((resp: unknown) => void) | undefined;
    const on = vi.fn((event: string, handler: (resp: unknown) => void) => {
      if (event === "response") {
        responseHandler = handler;
      }
    });
    const off = vi.fn();
    currentPage = { on, off };

    const resp = {
      url: () => "https://example.com/api/data",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      text: async () => '{"ok":true,"value":123}',
    };

    const mod = await importModule();
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
    currentRefLocator = { scrollIntoViewIfNeeded };
    currentPage = {};

    const mod = await importModule();
    await mod.scrollIntoViewViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
    });

    expect(sessionMocks.refLocator).toHaveBeenCalledWith(currentPage, "1");
    expect(scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 20_000 });
  });
  it("requires a ref for scrollIntoView", async () => {
    currentRefLocator = { scrollIntoViewIfNeeded: vi.fn(async () => {}) };
    currentPage = {};

    const mod = await importModule();
    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "   ",
      }),
    ).rejects.toThrow(/ref is required/i);
  });
});
