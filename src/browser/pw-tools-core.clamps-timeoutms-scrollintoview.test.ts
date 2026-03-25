import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
let mod: typeof import("./pw-tools-core.js");

describe("pw-tools-core", () => {
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./pw-tools-core.js");
  });

  it("clamps timeoutMs for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await mod.scrollIntoViewViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      timeoutMs: 50,
    });

    expect(scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 500 });
  });
  it.each([
    {
      name: "strict mode violations for scrollIntoView",
      errorMessage: 'Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements',
      expectedMessage: /Run a new snapshot/i,
    },
    {
      name: "not-visible timeouts for scrollIntoView",
      errorMessage: 'Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible',
      expectedMessage: /not found or not visible/i,
    },
  ])("rewrites $name", async ({ errorMessage, expectedMessage }) => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error(errorMessage);
    });
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(expectedMessage);
  });
  it.each([
    {
      name: "strict mode violations into snapshot hints",
      errorMessage: 'Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements',
      expectedMessage: /Run a new snapshot/i,
    },
    {
      name: "not-visible timeouts into snapshot hints",
      errorMessage: 'Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible',
      expectedMessage: /not found or not visible/i,
    },
  ])("rewrites $name", async ({ errorMessage, expectedMessage }) => {
    const evaluate = vi.fn(async () => false);
    const click = vi.fn(async () => {
      throw new Error(errorMessage);
    });
    setPwToolsCoreCurrentRefLocator({ evaluate, click });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(expectedMessage);
  });
  it("rewrites covered/hidden errors into interactable hints", async () => {
    const evaluate = vi.fn(async () => false);
    const click = vi.fn(async () => {
      throw new Error(
        "Element is not receiving pointer events because another element intercepts pointer events",
      );
    });
    setPwToolsCoreCurrentRefLocator({ evaluate, click });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not interactable/i);
  });

  it("scrolls offscreen targets before click and type", async () => {
    const order: string[] = [];
    const evaluate = vi.fn(async () => {
      order.push("evaluate");
      return true;
    });
    const click = vi.fn(async () => {
      order.push("click");
    });
    const fill = vi.fn(async () => {
      order.push("fill");
    });
    setPwToolsCoreCurrentRefLocator({ evaluate, click, fill });
    setPwToolsCoreCurrentPage({});

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
    });
    await mod.typeViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      text: "hello",
    });

    expect(order).toEqual(["evaluate", "click", "evaluate", "fill"]);
  });
});
