// Tests queue setting normalization and directive parsing.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveQueueSettingsCore } from "./settings.js";

describe("resolveQueueSettingsCore", () => {
  it("defaults inbound channels to steering settings", () => {
    expect(resolveQueueSettingsCore({ cfg: {} as OpenClawConfig })).toEqual({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it.each([
    { name: "no selection", overrides: {}, mode: "followup" },
    {
      name: "global config",
      overrides: { cfg: { messages: { queue: { mode: "steer" as const } } } },
      mode: "steer",
    },
    {
      name: "channel config",
      overrides: {
        cfg: {
          messages: {
            queue: { mode: "collect" as const, byChannel: { telegram: "steer" as const } },
          },
        },
      },
      mode: "steer",
    },
    {
      name: "session override",
      overrides: { sessionEntry: { sessionId: "test", updatedAt: 0, queueMode: "steer" as const } },
      mode: "steer",
    },
    {
      name: "inline directive",
      overrides: {
        inlineMode: "steer" as const,
        sessionEntry: { sessionId: "test", updatedAt: 0, queueMode: "collect" as const },
      },
      mode: "steer",
    },
  ])("resolves the ambient queue policy from $name", ({ overrides, mode }) => {
    expect(
      resolveQueueSettingsCore({
        cfg: {},
        channel: "telegram",
        defaultMode: "followup",
        ...overrides,
      }).mode,
    ).toBe(mode);
  });

  it("uses the short debounce when collect is selected globally", () => {
    expect(
      resolveQueueSettingsCore({
        cfg: {
          messages: {
            queue: {
              mode: "collect",
            },
          },
        } as OpenClawConfig,
      }),
    ).toEqual({
      mode: "collect",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it("keeps explicit channel queue overrides ahead of defaults", () => {
    expect(
      resolveQueueSettingsCore({
        cfg: {
          messages: {
            queue: {
              mode: "followup",
              byChannel: {
                discord: "collect",
              },
            },
          },
        } as OpenClawConfig,
        channel: "discord",
      }),
    ).toEqual({
      mode: "collect",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it("uses explicit steer mode from config", () => {
    expect(
      resolveQueueSettingsCore({
        cfg: {
          messages: {
            queue: {
              mode: "steer",
            },
          },
        } as OpenClawConfig,
      }),
    ).toEqual({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it("ignores removed steering queue modes from stale config", () => {
    expect(
      resolveQueueSettingsCore({
        cfg: {
          messages: {
            queue: {
              mode: "steer-backlog" as never,
            },
          },
        } as OpenClawConfig,
      }),
    ).toEqual({
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it("maps retired persisted session queue modes to compatible modes", () => {
    expect(
      resolveQueueSettingsCore({
        cfg: {} as OpenClawConfig,
        sessionEntry: { sessionId: "test-session", updatedAt: 0, queueMode: "queue" as never },
      }).mode,
    ).toBe("steer");
    expect(
      resolveQueueSettingsCore({
        cfg: {} as OpenClawConfig,
        sessionEntry: {
          sessionId: "test-session",
          updatedAt: 0,
          queueMode: "steer-backlog" as never,
        },
      }).mode,
    ).toBe("followup");
    expect(
      resolveQueueSettingsCore({
        cfg: {} as OpenClawConfig,
        sessionEntry: {
          sessionId: "test-session",
          updatedAt: 0,
          queueMode: "steer+backlog" as never,
        },
      }).mode,
    ).toBe("followup");
  });
});
