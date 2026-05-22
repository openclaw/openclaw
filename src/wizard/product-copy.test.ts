import { describe, expect, it } from "vitest";
import { applyClaworksWizardCopy } from "./product-copy.js";

describe("applyClaworksWizardCopy", () => {
  it("returns OpenClaw strings unchanged outside product mode", () => {
    expect(
      applyClaworksWizardCopy("wizard.setup.intro", "OpenClaw setup", {
        locale: "en",
        env: {},
      }),
    ).toBe("OpenClaw setup");
  });

  it("localizes setup intro for ClaWorks product mode", () => {
    expect(
      applyClaworksWizardCopy("wizard.setup.intro", "OpenClaw setup", {
        locale: "en",
        env: { CLAWORKS_PRODUCT: "1" },
      }),
    ).toBe("ClaWorks setup");
  });

  it("rewrites default gateway port hints in zh-CN", () => {
    const value = applyClaworksWizardCopy(
      "wizard.gateway.remote",
      "如果 Gateway 仅监听 loopback，请选择 SSH 隧道并保持 ws://127.0.0.1:18789。",
      { locale: "zh-CN", env: { CLAWORKS_PRODUCT: "1" } },
    );
    expect(value).toContain("18800");
    expect(value).not.toContain("18789");
  });
});
