import { describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core", () => {
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
  it("rewrites strict mode violations for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error('Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements');
    });
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/Run a new snapshot/i);
  });
  it("rewrites not-visible timeouts for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error('Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible');
    });
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not found or not visible/i);
  });
  it("rewrites strict mode violations into snapshot hints", async () => {
    const click = vi.fn(async () => {
      throw new Error('Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements');
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/Run a new snapshot/i);
  });
  it("rewrites not-visible timeouts into snapshot hints", async () => {
    const click = vi.fn(async () => {
      throw new Error('Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible');
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not found or not visible/i);
  });
  it("rewrites covered/hidden errors into interactable hints", async () => {
    const click = vi.fn(async () => {
      throw new Error(
        "Element is not receiving pointer events because another element intercepts pointer events",
      );
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not interactable/i);
  });
});
