import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

type FakeSession = {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

function createPage(opts: { targetId: string; snapshotFull?: string; hasSnapshotForAI?: boolean }) {
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
          _snapshotForAI: vi.fn().mockResolvedValue({ full: opts.snapshotFull ?? "SNAP" }),
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

let mod: typeof import("./pw-ai.js");
let chromiumMock: typeof import("playwright-core").chromium;

beforeAll(async () => {
  const pw = await import("playwright-core");
  chromiumMock = pw.chromium;
  mod = await import("./pw-ai.js");
});

afterEach(async () => {
  await mod.closePlaywrightBrowserConnection();
  vi.clearAllMocks();
});

describe("pw-ai", () => {
  it("captures an ai snapshot via Playwright for a specific target", async () => {
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    const p2 = createPage({ targetId: "T2", snapshotFull: "TWO" });
    const browser = createBrowser([p1.page, p2.page]);

    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

    const res = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T2",
    });

    expect(res.snapshot).toBe("TWO");
    expect(p1.session.detach).toHaveBeenCalledTimes(1);
    expect(p2.session.detach).toHaveBeenCalledTimes(1);
  });

  it("registers aria refs from ai snapshots for act commands", async () => {
    const snapshot = ['- button "OK" [ref=e1]', '- link "Docs" [ref=e2]'].join("\n");
    const p1 = createPage({ targetId: "T1", snapshotFull: snapshot });
    const browser = createBrowser([p1.page]);

    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

    const res = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
    });

    expect(res.refs).toMatchObject({
      e1: { role: "button", name: "OK" },
      e2: { role: "link", name: "Docs" },
    });

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e1",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=e1");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized snapshots", async () => {
    const longSnapshot = "A".repeat(20);
    const p1 = createPage({ targetId: "T1", snapshotFull: longSnapshot });
    const browser = createBrowser([p1.page]);

    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

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
    const p1 = createPage({ targetId: "T1" });
    const browser = createBrowser([p1.page]);
    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "76",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=76");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("fails with a clear error when _snapshotForAI is missing", async () => {
    const p1 = createPage({ targetId: "T1", hasSnapshotForAI: false });
    const browser = createBrowser([p1.page]);
    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

    await expect(
      mod.snapshotAiViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
      }),
    ).rejects.toThrow(/_snapshotForAI/i);
  });

  it("reuses the CDP connection for repeated calls", async () => {
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    const browser = createBrowser([p1.page]);
    const connect = vi.spyOn(chromiumMock, "connectOverCDP");
    connect.mockResolvedValue(browser);

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
