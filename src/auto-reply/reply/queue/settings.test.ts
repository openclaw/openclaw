// Tests queue setting normalization and directive parsing.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveQueueSettings } from "./settings-runtime.js";
import { resolveQueueSettingsCore } from "./settings.js";

describe("resolveQueueSettingsCore", () => {
  it.each([
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
  ] as const)("resolves $name with the built-in batching defaults", ({ params, mode }) => {
    expect(resolveQueueSettingsCore(params)).toEqual({
      mode,
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
    });
  });

  it("resolves plugin channel queue overrides", () => {
    expect(
      resolveQueueSettings({
        cfg: { messages: { queue: { byChannel: { buzz: "collect" } } } } as OpenClawConfig,
        channel: "buzz",
      }).mode,
    ).toBe("collect");
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
