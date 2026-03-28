import { describe, expect, it } from "vitest";
import {
  requiresNativeThreadContextForThreadHere,
  resolveThreadBindingPlacementForCurrentContext,
  supportsAutomaticThreadBindingSpawn,
} from "./thread-bindings-policy.js";

describe("thread binding spawn policy helpers", () => {
  it("treats Discord and Matrix as automatic child-thread spawn channels", () => {
    expect(supportsAutomaticThreadBindingSpawn("discord")).toBe(true);
    expect(supportsAutomaticThreadBindingSpawn("matrix")).toBe(true);
    expect(supportsAutomaticThreadBindingSpawn("telegram")).toBe(false);
  });

  it("allows thread-here on threadless conversation channels without a native thread id", () => {
    expect(requiresNativeThreadContextForThreadHere("telegram")).toBe(false);
    expect(requiresNativeThreadContextForThreadHere("feishu")).toBe(false);
    expect(requiresNativeThreadContextForThreadHere("discord")).toBe(true);
  });

  it("resolves current vs child placement from the current channel context", () => {
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "discord",
      }),
    ).toBe("child");
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "discord",
        threadId: "thread-1",
      }),
    ).toBe("current");
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "telegram",
      }),
    ).toBe("current");
  });
});
