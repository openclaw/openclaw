import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config validation telegram streamThrottleMs and minInitialChars", () => {
  it("accepts valid streamThrottleMs values", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: 250,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts valid minInitialChars values", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          minInitialChars: 30,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts both streamThrottleMs and minInitialChars together", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: 500,
          minInitialChars: 50,
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid streamThrottleMs (negative)", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: -1,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects invalid streamThrottleMs (zero)", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: 0,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects streamThrottleMs below minimum (249)", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: 249,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects invalid streamThrottleMs (non-integer)", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          streamThrottleMs: 100.5,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects invalid minInitialChars (negative)", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          minInitialChars: -5,
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("accepts minInitialChars of zero", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "test",
          allowFrom: ["*"],
          dmPolicy: "open",
          minInitialChars: 0,
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
