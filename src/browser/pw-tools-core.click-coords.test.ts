import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sendCalls: [] as Array<{ method: string; params?: Record<string, unknown> }>,
}));

const mocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => ({ id: "page" })),
  refLocator: vi.fn(() => {
    throw new Error("refLocator should not be used for click-coords");
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  withPageScopedCdpClient: vi.fn(
    async ({
      fn,
    }: {
      fn: (
        send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
      ) => Promise<unknown>;
    }) => {
      state.sendCalls = [];
      const send = async (method: string, params?: Record<string, unknown>) => {
        state.sendCalls.push({ method, params });
        return {};
      };
      return await fn(send);
    },
  ),
}));

vi.mock("./pw-session.js", () => ({
  ensurePageState: mocks.ensurePageState,
  forceDisconnectPlaywrightForTarget: mocks.forceDisconnectPlaywrightForTarget,
  getPageForTargetId: mocks.getPageForTargetId,
  refLocator: mocks.refLocator,
  restoreRoleRefsForTarget: mocks.restoreRoleRefsForTarget,
}));

vi.mock("./pw-session.page-cdp.js", () => ({
  withPageScopedCdpClient: mocks.withPageScopedCdpClient,
}));

let mod: typeof import("./pw-tools-core.js");

describe("pw-tools-core click-coords", () => {
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./pw-tools-core.js");
  });

  beforeEach(() => {
    state.sendCalls = [];
    for (const fn of Object.values(mocks)) {
      fn.mockClear();
    }
  });

  it("dispatches mouse events through a page-scoped CDP session", async () => {
    const result = await mod.clickCoordsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      x: 125.4,
      y: 260.8,
      doubleClick: true,
    });

    expect(result).toEqual({ x: 125, y: 261 });
    expect(mocks.withPageScopedCdpClient).toHaveBeenCalled();
    expect(state.sendCalls.map((call) => call.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(state.sendCalls[0]).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 125, y: 261 },
    });
    expect(state.sendCalls[1]?.params).toMatchObject({
      type: "mousePressed",
      x: 125,
      y: 261,
      clickCount: 1,
    });
    expect(state.sendCalls[4]?.params).toMatchObject({
      type: "mouseReleased",
      x: 125,
      y: 261,
      clickCount: 2,
    });
  });
});
