// Persisted auth state tests cover channel plugin auth state serialization and recovery.
import { describe, expect, it } from "vitest";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

describe("bundled channel persisted-auth metadata", () => {
  it("lists shipped persisted-auth metadata channels", () => {
    expect(listBundledChannelIdsForPackageState("persistedAuthState")).toEqual([
      "matrix",
      "whatsapp",
    ]);
  });

  it("does not report auth state for channels without bundled metadata", () => {
    expect(
      hasBundledChannelPackageState({
        metadataKey: "persistedAuthState",
        channelId: "discord",
        cfg: {},
        env: {},
      }),
    ).toBe(false);
  });
});
