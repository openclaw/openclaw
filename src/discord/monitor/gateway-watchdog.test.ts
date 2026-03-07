import { describe, expect, it } from "vitest";
import {
  createDiscordGatewayWatchdog,
  shouldRestartDiscordGatewayProcessForError,
} from "./gateway-watchdog.js";

describe("discord gateway watchdog", () => {
  it("marks zombie reconnect errors as restart-worthy", () => {
    expect(
      shouldRestartDiscordGatewayProcessForError(
        new Error("Attempted to reconnect zombie connection after disconnecting first"),
      ),
    ).toBe(true);
    expect(
      shouldRestartDiscordGatewayProcessForError(
        new Error("Max reconnect attempts (0) reached after code 1006"),
      ),
    ).toBe(true);
    expect(shouldRestartDiscordGatewayProcessForError(new Error("socket hang up"))).toBe(false);
  });

  it("restarts only after repeated hello stalls within the window", () => {
    let nowMs = 0;
    const watchdog = createDiscordGatewayWatchdog({
      now: () => nowMs,
      stallThreshold: 2,
      stallWindowMs: 60_000,
    });

    expect(watchdog.recordHelloTimeout()).toBe(false);
    nowMs += 30_000;
    expect(watchdog.recordHelloTimeout()).toBe(true);
  });

  it("forgets old hello stalls after the window elapses", () => {
    let nowMs = 0;
    const watchdog = createDiscordGatewayWatchdog({
      now: () => nowMs,
      stallThreshold: 2,
      stallWindowMs: 60_000,
    });

    expect(watchdog.recordHelloTimeout()).toBe(false);
    nowMs += 61_000;
    expect(watchdog.recordHelloTimeout()).toBe(false);
    expect(watchdog.getHelloTimeoutCount()).toBe(1);
  });
});
