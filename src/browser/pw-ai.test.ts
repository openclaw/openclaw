import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

type FakeSession = {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

function createPage(opts: {
  targetId: string;
  snapshotFull?: string;
  hasSnapshotForAI?: boolean;
}) {
  const session: FakeSession = {
    send: vi.fn().mockResolvedValue({
      targetInfo: { targetId: opts.targetId },
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const context = {
    newCDPSession: vi.fn().mockResolvedValue(session),
  };

  const click = vi.fn().mockResolvedValue(undefined);
  const dblclick = vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn().mockReturnValue({ click, dblclick, fill });

  const page = {
    context: () => context,
    locator,
    on: vi.fn(),
    ...(opts.hasSnapshotForAI === false
      ? {}
      : {
          _snapshotForAI: vi
            .fn()
            .mockResolvedValue({ full: opts.snapshotFull ?? "SNAP" }),
        }),
  };

  return { page, session, locator, click, fill };
}

function createBrowser(pages: unknown[]) {
  const ctx = {
    pages: () => pages,
    on: vi.fn(),
  };
  return {
    contexts: () => [ctx],
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function importModule() {
  return await import("./pw-ai.js");
}

afterEach(async () => {
  const mod = await importModule();
  await mod.closePlaywrightBrowserConnection();
  vi.clearAllMocks();
});

describe("pw-ai", () => {
  it("captures an ai snapshot via Playwright for a specific target", async () => {
    const { chromium } = await import("playwright-core");
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    const p2 = createPage({ targetId: "T2", snapshotFull: "TWO" });
    const browser = createBrowser([p1.page, p2.page]);

    (
      chromium.connectOverCDP as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue(browser);

    const mod = await importModule();
    const res = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T2",
    });

    expect(res.snapshot).toBe("TWO");
    expect(p1.session.detach).toHaveBeenCalledTimes(1);
    expect(p2.session.detach).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized snapshots", async () => {
    const { chromium } = await import("playwright-core");
    const longSnapshot = "A".repeat(20);
    const p1 = createPage({ targetId: "T1", snapshotFull: longSnapshot });
    const browser = createBrowser([p1.page]);

    (
      chromium.connectOverCDP as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue(browser);

    const mod = await importModule();
    const res = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      maxChars: 10,
    });

    expect(res.truncated).toBe(true);
    expect(res.snapshot.startsWith("AAAAAAAAAA")).toBe(true);
    expect(res.snapshot).toContain("TRUNCATED");
  });

  it("clicks a ref using aria-ref locator", async () => {
    const { chromium } = await import("playwright-core");
    const p1 = createPage({ targetId: "T1" });
    const browser = createBrowser([p1.page]);
    (
      chromium.connectOverCDP as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue(browser);

    const mod = await importModule();
    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "76",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=76");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("fails with a clear error when _snapshotForAI is missing", async () => {
    const { chromium } = await import("playwright-core");
    const p1 = createPage({ targetId: "T1", hasSnapshotForAI: false });
    const browser = createBrowser([p1.page]);
    (
      chromium.connectOverCDP as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue(browser);

    const mod = await importModule();
    await expect(
      mod.snapshotAiViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
      }),
    ).rejects.toThrow(/_snapshotForAI/i);
  });

  it("reuses the CDP connection for repeated calls", async () => {
    const { chromium } = await import("playwright-core");
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    const browser = createBrowser([p1.page]);
    const connect = vi.spyOn(chromium, "connectOverCDP");
    connect.mockResolvedValue(browser);

    const mod = await importModule();
    await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
    });
    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
    });

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
