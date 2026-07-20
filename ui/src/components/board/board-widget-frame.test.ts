/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { resolveBoardFrameFailureMessage } from "./board-widget-frame.ts";

describe("resolveBoardFrameFailureMessage", () => {
  it("points at mcp.apps.sandboxOrigin when a derived remote sandbox origin fails", () => {
    const message = resolveBoardFrameFailureMessage({}, "https://team.example.com:18790");
    expect(message).toContain("mcp.apps.sandboxOrigin");
  });

  it("keeps the authorization message when a sandbox origin is explicitly configured", () => {
    const message = resolveBoardFrameFailureMessage(
      { sandboxOrigin: "https://widgets.example.com" },
      "https://widgets.example.com",
    );
    expect(message).toContain("authorization failed");
  });

  it("keeps the authorization message for loopback sandbox hosts", () => {
    for (const origin of [
      "http://localhost:18790",
      "http://127.0.0.1:18790",
      "http://[::1]:18790",
    ]) {
      expect(resolveBoardFrameFailureMessage({}, origin)).toContain("authorization failed");
    }
  });

  it("keeps the authorization message when no sandbox origin was resolved", () => {
    expect(resolveBoardFrameFailureMessage({}, "")).toContain("authorization failed");
  });
});
