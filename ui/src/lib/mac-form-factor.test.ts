// @vitest-environment node
import { describe, expect, it } from "vitest";
import { macFamilyLabel, resolveMacFormFactorFromName } from "./mac-form-factor.ts";

describe("Mac model identity", () => {
  it.each([
    ["MacBook10,1", "MacBook"],
    ["MacBookPro18,1", "MacBook Pro"],
    ["MacBookAir10,1", "MacBook Air"],
    ["Macmini9,1", "Mac mini"],
    ["MacPro7,1", "Mac Pro"],
    ["iMac21,1", "iMac"],
    ["Mac13,1", "Mac Studio"],
    ["Mac14,8", "Mac Pro"],
    ["Mac14,2", "MacBook Air"],
    ["Mac15,14", "Mac Studio"],
    ["Mac15,5", "iMac"],
    ["Mac16,11", "Mac mini"],
    ["Mac16,6", "MacBook Pro"],
    ["Mac17,2", "MacBook Pro"],
    ["Mac16,12", "MacBook Air"],
    ["Mac99,99", undefined],
    ["constructor", undefined],
    ["__proto__", undefined],
    [undefined, undefined],
  ])("identifies %s without guessing unknown models", (model, label) => {
    expect(macFamilyLabel(model)).toBe(label);
  });
});

describe("Mac display-name hints", () => {
  it.each([
    ["Work MacBook Pro", "laptop"],
    ["work_MACBOOK_AIR", "laptop"],
    ["Personal MacBook", "laptop"],
    ["Office Mac mini", "mini"],
    ["office-mac-mini", "mini"],
    ["Build Mac Studio", "studio"],
    ["  BUILD_MAC_STUDIO  ", "studio"],
    ["studio", undefined],
    ["mini runner", undefined],
    ["MacBookish workstation", undefined],
    ["Mac minibus", undefined],
    ["Development workstation", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("recognizes only explicit Mac model names in %s", (name, formFactor) => {
    expect(resolveMacFormFactorFromName(name)).toBe(formFactor);
  });
});
