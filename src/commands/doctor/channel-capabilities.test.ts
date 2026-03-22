import { describe, expect, it } from "vitest";
import { getDoctorChannelCapabilities } from "./channel-capabilities.js";

describe("doctor channel capabilities", () => {
  it("returns built-in capability overrides for matrix", () => {
    expect(getDoctorChannelCapabilities("matrix")).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
    });
  });

  it("returns hybrid group semantics for zalouser", () => {
    expect(getDoctorChannelCapabilities("zalouser")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "hybrid",
      groupAllowFromFallbackToAllowFrom: false,
    });
  });

  it("falls back conservatively for unknown external channels", () => {
    expect(getDoctorChannelCapabilities("external-demo")).toEqual({
      dmAllowFromMode: "topOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: true,
    });
  });
});
