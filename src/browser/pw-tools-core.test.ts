import { beforeEach, describe, expect, it, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let pageState: { console: unknown[]; armIdUpload: number; armIdDialog: number };

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) throw new Error("missing page");
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) throw new Error("missing locator");
    return currentRefLocator;
  }),
}));

vi.mock("./pw-session.js", () => sessionMocks);

async function importModule() {
  return await import("./pw-tools-core.js");
}

describe("pw-tools-core", () => {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    pageState = { console: [], armIdUpload: 0, armIdDialog: 0 };
    for (const fn of Object.values(sessionMocks)) fn.mockClear();
  });

  it("screenshots an element selector", async () => {
    const elementScreenshot = vi.fn(async () => Buffer.from("E"));
    currentPage = {
      locator: vi.fn(() => ({
        first: () => ({ screenshot: elementScreenshot }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();
    const res = await mod.takeScreenshotViaPlaywright({
      cdpPort: 18792,
      targetId: "T1",
      element: "#main",
      type: "png",
    });

    expect(res.buffer.toString()).toBe("E");
    expect(sessionMocks.getPageForTargetId).toHaveBeenCalled();
    expect(
      currentPage.locator as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith("#main");
    expect(elementScreenshot).toHaveBeenCalledWith({ type: "png" });
  });

  it("screenshots a ref locator", async () => {
    const refScreenshot = vi.fn(async () => Buffer.from("R"));
    currentRefLocator = { screenshot: refScreenshot };
    currentPage = {
      locator: vi.fn(),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();
    const res = await mod.takeScreenshotViaPlaywright({
      cdpPort: 18792,
      targetId: "T1",
      ref: "76",
      type: "jpeg",
    });

    expect(res.buffer.toString()).toBe("R");
    expect(sessionMocks.refLocator).toHaveBeenCalledWith(currentPage, "76");
    expect(refScreenshot).toHaveBeenCalledWith({ type: "jpeg" });
  });

  it("rejects fullPage for element or ref screenshots", async () => {
    currentRefLocator = { screenshot: vi.fn(async () => Buffer.from("R")) };
    currentPage = {
      locator: vi.fn(() => ({
        first: () => ({ screenshot: vi.fn(async () => Buffer.from("E")) }),
      })),
      screenshot: vi.fn(async () => Buffer.from("P")),
    };

    const mod = await importModule();

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpPort: 18792,
        targetId: "T1",
        element: "#x",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);

    await expect(
      mod.takeScreenshotViaPlaywright({
        cdpPort: 18792,
        targetId: "T1",
        ref: "1",
        fullPage: true,
      }),
    ).rejects.toThrow(/fullPage is not supported/i);
  });

  it("arms the next file chooser and sets files (default timeout)", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const waitForEvent = vi.fn(
      async (_event: string, _opts: unknown) => fileChooser,
    );
    currentPage = {
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({
      cdpPort: 18792,
      targetId: "T1",
      paths: ["/tmp/a.txt"],
    });

    // waitForEvent is awaited immediately; handler continues async.
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("filechooser", {
      timeout: 30_000,
    });
    expect(fileChooser.setFiles).toHaveBeenCalledWith(["/tmp/a.txt"]);
  });

  it("arms the next file chooser and escapes if no paths provided", async () => {
    const fileChooser = { setFiles: vi.fn(async () => {}) };
    const press = vi.fn(async () => {});
    const waitForEvent = vi.fn(async () => fileChooser);
    currentPage = {
      waitForEvent,
      keyboard: { press },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({ cdpPort: 18792, paths: [] });
    await Promise.resolve();

    expect(fileChooser.setFiles).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledWith("Escape");
  });

  it("last file-chooser arm wins", async () => {
    let resolve1: ((value: unknown) => void) | null = null;
    let resolve2: ((value: unknown) => void) | null = null;

    const fc1 = { setFiles: vi.fn(async () => {}) };
    const fc2 = { setFiles: vi.fn(async () => {}) };

    const waitForEvent = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve1 = r;
          }) as Promise<unknown>,
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve2 = r;
          }) as Promise<unknown>,
      );

    currentPage = {
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    };

    const mod = await importModule();
    await mod.armFileUploadViaPlaywright({ cdpPort: 18792, paths: ["/tmp/1"] });
    await mod.armFileUploadViaPlaywright({ cdpPort: 18792, paths: ["/tmp/2"] });

    resolve1?.(fc1);
    resolve2?.(fc2);
    await Promise.resolve();

    expect(fc1.setFiles).not.toHaveBeenCalled();
    expect(fc2.setFiles).toHaveBeenCalledWith(["/tmp/2"]);
  });

  it("arms the next dialog and accepts/dismisses (default timeout)", async () => {
    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});
    const dialog = { accept, dismiss };
    const waitForEvent = vi.fn(async () => dialog);
    currentPage = {
      waitForEvent,
    };

    const mod = await importModule();
    await mod.armDialogViaPlaywright({
      cdpPort: 18792,
      accept: true,
      promptText: "x",
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 30_000 });
    expect(accept).toHaveBeenCalledWith("x");
    expect(dismiss).not.toHaveBeenCalled();

    accept.mockClear();
    dismiss.mockClear();
    waitForEvent.mockClear();

    await mod.armDialogViaPlaywright({
      cdpPort: 18792,
      accept: false,
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 30_000 });
    expect(dismiss).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
