// Tests queue setting normalization and directive parsing.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveQueueSettingsCore } from "./settings.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

// The table is annotated instead of `as const` so every row shares one fixture type.
// Per-row literal types get unioned, and TypeScript fills in the keys a row omits as
// `?: undefined`, which no longer matches the open-ended channel-id index signature on
// `messages.queue.byChannel`.
type BatchingDefaultsCase = {
  name: string;
  params: ResolveQueueSettingsParams;
  mode: QueueSettings["mode"];
};

describe("resolveQueueSettingsCore", () => {
  it.each<BatchingDefaultsCase>([
    { name: "inbound defaults", params: { cfg: {} }, mode: "steer" },
    {
      name: "global collect",
      params: { cfg: { messages: { queue: { mode: "collect" } } } },
      mode: "collect",
    },
    {
      name: "channel override before global mode",
      params: {
        cfg: { messages: { queue: { mode: "followup", byChannel: { discord: "collect" } } } },
        channel: "discord",
      },
      mode: "collect",
    },
    {
      name: "removed mode in stale config",
      params: { cfg: { messages: { queue: { mode: "steer-backlog" as never } } } },
      mode: "steer",
    },
    {
      name: "plugin channel override",
      params: {
        cfg: { messages: { queue: { mode: "steer", byChannel: { buzz: "collect" } } } },
        channel: "buzz",
      },
      mode: "collect",
    },
  ])("resolves $name with the built-in batching defaults", ({ params, mode }) => {
    expect(resolveQueueSettingsCore(params)).toEqual({
      mode,
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
