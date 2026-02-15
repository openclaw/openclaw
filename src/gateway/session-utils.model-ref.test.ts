import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelRef } from "./session-utils.js";

describe("resolveSessionModelRef", () => {
  it("switches xai fast model to reasoning variant for thinking on", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "xai/grok-4-1-fast" },
          thinkingDefault: "high",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveSessionModelRef(cfg);
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast-reasoning",
    });
  });

  it("switches xai fast model to non-reasoning variant when session thinking is off", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "xai/grok-4-1-fast" },
          thinkingDefault: "high",
        },
      },
    } as OpenClawConfig;

    const entry = {
      sessionId: "s",
      updatedAt: Date.now(),
      thinkingLevel: "off",
    } as SessionEntry;

    const resolved = resolveSessionModelRef(cfg, entry);
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast-non-reasoning",
    });
  });
});
