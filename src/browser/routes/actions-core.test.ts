import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserRouteContext } from "../server-context.js";

const pw = vi.hoisted(() => ({
  armDialogViaPlaywright: vi.fn().mockResolvedValue(undefined),
  armFileUploadViaPlaywright: vi.fn().mockResolvedValue(undefined),
  clickViaPlaywright: vi.fn().mockResolvedValue(undefined),
  closePageViaPlaywright: vi.fn().mockResolvedValue(undefined),
  dragViaPlaywright: vi.fn().mockResolvedValue(undefined),
  evaluateViaPlaywright: vi.fn().mockResolvedValue("result"),
  fillFormViaPlaywright: vi.fn().mockResolvedValue(undefined),
  hoverViaPlaywright: vi.fn().mockResolvedValue(undefined),
  navigateViaPlaywright: vi
    .fn()
    .mockResolvedValue({ url: "https://example.com" }),
  pressKeyViaPlaywright: vi.fn().mockResolvedValue(undefined),
  resizeViewportViaPlaywright: vi.fn().mockResolvedValue(undefined),
  selectOptionViaPlaywright: vi.fn().mockResolvedValue(undefined),
  typeViaPlaywright: vi.fn().mockResolvedValue(undefined),
  waitForViaPlaywright: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pw-ai.js", () => pw);

import { handleBrowserActionCore } from "./actions-core.js";

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
    listTabs: vi
      .fn()
      .mockResolvedValue([
        baseTab,
        { targetId: "tab2", title: "Two", url: "https://example.com/2" },
      ]),
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
  action: Parameters<typeof handleBrowserActionCore>[0]["action"],
  args: Record<string, unknown> = {},
  ctxOverride?: Partial<BrowserRouteContext>,
) {
  const res = createRes();
  const ctx = createCtx(ctxOverride);
  const handled = await handleBrowserActionCore({
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

describe("handleBrowserActionCore", () => {
  it("dispatches core browser actions", async () => {
    const cases = [
      {
        action: "close" as const,
        args: {},
        fn: pw.closePageViaPlaywright,
        expectArgs: { cdpPort: 18792, targetId: "tab1" },
        expectBody: { ok: true, targetId: "tab1", url: baseTab.url },
      },
      {
        action: "resize" as const,
        args: { width: 800, height: 600 },
        fn: pw.resizeViewportViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          width: 800,
          height: 600,
        },
        expectBody: { ok: true, targetId: "tab1", url: baseTab.url },
      },
      {
        action: "dialog" as const,
        args: { accept: true, promptText: "ok" },
        fn: pw.armDialogViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          accept: true,
          promptText: "ok",
        },
        expectBody: { ok: true },
      },
      {
        action: "evaluate" as const,
        args: { function: "() => 1", ref: "1" },
        fn: pw.evaluateViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          fn: "() => 1",
          ref: "1",
        },
        expectBody: { ok: true, result: "result" },
      },
      {
        action: "upload" as const,
        args: { paths: ["/tmp/file.txt"] },
        fn: pw.armFileUploadViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          paths: ["/tmp/file.txt"],
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "fill" as const,
        args: { fields: [{ ref: "1", value: "x" }] },
        fn: pw.fillFormViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          fields: [{ ref: "1", value: "x" }],
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "press" as const,
        args: { key: "Enter" },
        fn: pw.pressKeyViaPlaywright,
        expectArgs: { cdpPort: 18792, targetId: "tab1", key: "Enter" },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "type" as const,
        args: { ref: "2", text: "hi", submit: true, slowly: true },
        fn: pw.typeViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          ref: "2",
          text: "hi",
          submit: true,
          slowly: true,
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "navigate" as const,
        args: { url: "https://example.com" },
        fn: pw.navigateViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          url: "https://example.com",
        },
        expectBody: { ok: true, targetId: "tab1", url: baseTab.url },
      },
      {
        action: "click" as const,
        args: {
          ref: "1",
          doubleClick: true,
          button: "right",
          modifiers: ["Shift"],
        },
        fn: pw.clickViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          ref: "1",
          doubleClick: true,
          button: "right",
          modifiers: ["Shift"],
        },
        expectBody: { ok: true, targetId: "tab1", url: baseTab.url },
      },
      {
        action: "drag" as const,
        args: { startRef: "1", endRef: "2" },
        fn: pw.dragViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          startRef: "1",
          endRef: "2",
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "hover" as const,
        args: { ref: "3" },
        fn: pw.hoverViaPlaywright,
        expectArgs: { cdpPort: 18792, targetId: "tab1", ref: "3" },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "select" as const,
        args: { ref: "4", values: ["A"] },
        fn: pw.selectOptionViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          ref: "4",
          values: ["A"],
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
      {
        action: "wait" as const,
        args: { time: 500, text: "ok", textGone: "bye" },
        fn: pw.waitForViaPlaywright,
        expectArgs: {
          cdpPort: 18792,
          targetId: "tab1",
          time: 500,
          text: "ok",
          textGone: "bye",
        },
        expectBody: { ok: true, targetId: "tab1" },
      },
    ];

    for (const item of cases) {
      const { res, handled } = await callAction(item.action, item.args);
      expect(handled).toBe(true);
      expect(item.fn).toHaveBeenCalledWith(item.expectArgs);
      expect(res.body).toEqual(item.expectBody);
    }
  });
});
