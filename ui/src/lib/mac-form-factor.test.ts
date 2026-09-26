// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  macFamilyLabel,
  resolveMacFormFactor,
  resolveMacFormFactorFromName,
} from "./mac-form-factor.ts";

describe("Mac model identity", () => {
  it.each([
    ["MacBook10,1", "laptop", "MacBook"],
    ["MacBookPro18,1", "laptop", "MacBook Pro"],
    ["MacBookAir10,1", "laptop", "MacBook Air"],
    ["Macmini9,1", "mini", "Mac mini"],
    ["MacPro7,1", "pro", "Mac Pro"],
    ["iMac21,1", "imac", "iMac"],
    ["Mac13,1", "studio", "Mac Studio"],
    ["Mac14,8", "pro", "Mac Pro"],
    ["Mac14,2", "laptop", "MacBook Air"],
    ["Mac15,14", "studio", "Mac Studio"],
    ["Mac15,5", "imac", "iMac"],
    ["Mac16,11", "mini", "Mac mini"],
    ["Mac16,6", "laptop", "MacBook Pro"],
    ["Mac17,2", "laptop", "MacBook Pro"],
    ["Mac16,12", "laptop", "MacBook Air"],
    ["Mac99,99", undefined, undefined],
    [undefined, undefined, undefined],
  ])("identifies %s without guessing unknown models", (model, formFactor, label) => {
    expect(resolveMacFormFactor(model)).toBe(formFactor);
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
