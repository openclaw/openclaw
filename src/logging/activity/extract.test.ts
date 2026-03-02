import { describe, expect, it } from "vitest";
import { extractActivityMetaFromMessage } from "./extract.js";

describe("extractActivityMetaFromMessage policy fallback", () => {
  it("maps blocked policy logs to policy activity", () => {
    const activity = extractActivityMetaFromMessage("Send blocked by policy for session abc-123");
    expect(activity).toMatchObject({
      kind: "policy",
      status: "blocked",
      summary: "policy decision",
    });
  });

  it("maps skipping policy logs to policy activity", () => {
    const activity = extractActivityMetaFromMessage(
      "discord: skipping group message (dmPolicy=allowlist)",
    );
    expect(activity).toMatchObject({
      kind: "policy",
      status: "skip",
      summary: "policy decision",
    });
  });

  it("does not treat unrelated skipping warnings as policy activity", () => {
    const activity = extractActivityMetaFromMessage(
      "session maintenance would evict active session; skipping enforcement",
    );
    expect(activity).toBeUndefined();
  });

  it("does not treat unrelated blocked warnings as policy activity", () => {
    const activity = extractActivityMetaFromMessage(
      "Blocked sensitive environment variables for skill env overrides",
    );
    expect(activity).toBeUndefined();
  });
});
