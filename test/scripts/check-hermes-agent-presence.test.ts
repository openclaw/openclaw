import { describe, expect, it } from "vitest";
import {
  isOfficialHermesRemote,
  normalizeHermesMode,
  normalizeHermesRemoteUrl,
} from "../../scripts/check-hermes-agent-presence.mjs";

describe("check-hermes-agent-presence helpers", () => {
  it("normalizes official Hermes remotes with and without .git", () => {
    expect(normalizeHermesRemoteUrl("https://github.com/NousResearch/hermes-agent")).toBe(
      "https://github.com/NousResearch/hermes-agent.git",
    );
    expect(isOfficialHermesRemote("https://github.com/NousResearch/hermes-agent.git")).toBe(true);
  });

  it("rejects non-official Hermes remotes", () => {
    expect(isOfficialHermesRemote("https://github.com/example/hermes-agent.git")).toBe(false);
    expect(isOfficialHermesRemote("git@github.com:NousResearch/hermes-agent.git")).toBe(false);
  });

  it("accepts only supported Hermes runtime modes", () => {
    expect(normalizeHermesMode(undefined)).toBe("mock");
    expect(normalizeHermesMode("real")).toBe("real");
    expect(normalizeHermesMode("invalid")).toBeUndefined();
  });
});
