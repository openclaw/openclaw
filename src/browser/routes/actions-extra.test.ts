import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserRouteContext } from "../server-context.js";

const pw = vi.hoisted(() => ({
  getConsoleMessagesViaPlaywright: vi.fn().mockResolvedValue([]),
  mouseClickViaPlaywright: vi.fn().mockResolvedValue(undefined),
  mouseDragViaPlaywright: vi.fn().mockResolvedValue(undefined),
  mouseMoveViaPlaywright: vi.fn().mockResolvedValue(undefined),
  pdfViaPlaywright: vi.fn().mockResolvedValue({ buffer: Buffer.from("pdf") }),
  verifyElementVisibleViaPlaywright: vi.fn().mockResolvedValue(undefined),
  verifyListVisibleViaPlaywright: vi.fn().mockResolvedValue(undefined),
  verifyTextVisibleViaPlaywright: vi.fn().mockResolvedValue(undefined),
  verifyValueViaPlaywright: vi.fn().mockResolvedValue(undefined),
}));

const media = vi.hoisted(() => ({
  ensureMediaDir: vi.fn().mockResolvedValue(undefined),
  saveMediaBuffer: vi.fn().mockResolvedValue({ path: "/tmp/fake.pdf" }),
}));

vi.mock("../pw-ai.js", () => pw);
vi.mock("../../media/store.js", () => media);

import { handleBrowserActionExtra } from "./actions-extra.js";

const baseTab = {
  targetId: "tab1",
  title: "One",
  url: "https://example.com",
};

function createRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function createCtx(
  overrides: Partial<BrowserRouteContext> = {},
): BrowserRouteContext {
  return {
    state: () => {
      throw new Error("unused");
    },
    ensureBrowserAvailable: vi.fn().mockResolvedValue(undefined),
    ensureTabAvailable: vi.fn().mockResolvedValue(baseTab),
    isReachable: vi.fn().mockResolvedValue(true),
    listTabs: vi.fn().mockResolvedValue([baseTab]),
    openTab: vi.fn().mockResolvedValue({
      targetId: "newtab",
      title: "",
      url: "about:blank",
      type: "page",
    }),
    focusTab: vi.fn().mockResolvedValue(undefined),
    closeTab: vi.fn().mockResolvedValue(undefined),
    stopRunningBrowser: vi.fn().mockResolvedValue({ stopped: true }),
    mapTabError: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

async function callAction(
  action: Parameters<typeof handleBrowserActionExtra>[0]["action"],
  args: Record<string, unknown> = {},
) {
  const res = createRes();
  const ctx = createCtx();
  const handled = await handleBrowserActionExtra({
    action,
    args,
    targetId: "",
    cdpPort: 18792,
    ctx,
    res,
  });
  return { res, ctx, handled };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleBrowserActionExtra", () => {
  it("dispatches extra browser actions", async () => {
    const cases = [
      {
        action: "console" as const,
        args: { level: "error" },
        fn: pw.getConsoleMessagesViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          level: "error",
        },
        expectBody: { ok: true, messages: [], targetId: "tab1" },
      },
      {
        action: "verifyElement" as const,
        args: { role: "button", accessibleName: "Submit" },
        fn: pw.verifyElementVisibleViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          role: "button",
          accessibleName: "Submit",
        },
        expectBody: { ok: true },
      },
      {
        action: "verifyText" as const,
        args: { text: "Hello" },
        fn: pw.verifyTextVisibleViaPlaywright,
        expectArgs: { cdpPort: 18792, targetId: "tab1", text: "Hello" },
        expectBody: { ok: true },
      },
      {
        action: "verifyList" as const,
        args: { ref: "1", items: ["a", "b"] },
        fn: pw.verifyListVisibleViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          ref: "1",
          items: ["a", "b"],
        },
        expectBody: { ok: true },
      },
      {
        action: "verifyValue" as const,
        args: { ref: "2", type: "textbox", value: "x" },
        fn: pw.verifyValueViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          ref: "2",
          type: "textbox",
          value: "x",
        },
        expectBody: { ok: true },
      },
      {
        action: "mouseMove" as const,
        args: { x: 10, y: 20 },
        fn: pw.mouseMoveViaPlaywright,
        expectArgs: { cdpPort: 18792, targetId: "tab1", x: 10, y: 20 },
        expectBody: { ok: true },
      },
      {
        action: "mouseClick" as const,
        args: { x: 1, y: 2, button: "right" },
        fn: pw.mouseClickViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          x: 1,
          y: 2,
          button: "right",
        },
        expectBody: { ok: true },
      },
      {
        action: "mouseDrag" as const,
        args: { startX: 1, startY: 2, endX: 3, endY: 4 },
        fn: pw.mouseDragViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          startX: 1,
          startY: 2,
          endX: 3,
          endY: 4,
        },
        expectBody: { ok: true },
      },
    ];

    for (const item of cases) {
      const { res, handled } = await callAction(item.action, item.args);
      expect(handled).toBe(true);
      expect(item.fn).toHaveBeenCalledWith(item.expectArgs);
      expect(res.body).toEqual(item.expectBody);
    }
  });

  it("stores PDF output", async () => {
    const { res: pdfRes } = await callAction("pdf");
    expect(pw.pdfViaPlaywright).toHaveBeenCalledWith({
      cdpPort: 18792,
      targetId: "tab1",
    });
    expect(media.ensureMediaDir).toHaveBeenCalled();
    expect(media.saveMediaBuffer).toHaveBeenCalled();
    expect(pdfRes.body).toMatchObject({
      ok: true,
      path: "/tmp/fake.pdf",
      targetId: "tab1",
      url: baseTab.url,
    });
  });
});
