/** The Runtime prompt line renders this scope; a volatile id there defeats prompt-prefix reuse. */
import { describe, expect, it } from "vitest";
import { parseCacheStableSessionScope } from "./session-key-utils.js";

describe("parseCacheStableSessionScope", () => {
  it("strips the per-run scope of an isolated cron key", () => {
    expect(parseCacheStableSessionScope("agent:main:cron:job:run:attempt-1")).toEqual({
      baseSessionKey: "agent:main:cron:job",
      isVolatile: true,
    });
  });

  it("drops the chat id of a dashboard session", () => {
    expect(parseCacheStableSessionScope("agent:main:dashboard:0f0e-uuid")).toEqual({
      baseSessionKey: "agent:main:dashboard",
      isVolatile: true,
    });
    expect(parseCacheStableSessionScope("agent:main:dashboard:incognito-1234")).toEqual({
      baseSessionKey: "agent:main:dashboard:incognito",
      isVolatile: true,
    });
  });

  it("drops the spawn id of a subagent session", () => {
    // Two spawns of the same shape must render the same Runtime line, otherwise every child ships
    // a unique prompt and no provider-side cache can be reused for it.
    expect(parseCacheStableSessionScope("agent:main:subagent:7c0011f7-uuid")).toEqual({
      baseSessionKey: "agent:main:subagent",
      isVolatile: true,
    });
    expect(parseCacheStableSessionScope("agent:main:subagent:other-uuid").baseSessionKey).toBe(
      parseCacheStableSessionScope("agent:main:subagent:7c0011f7-uuid").baseSessionKey,
    );
  });

  it("keeps an ordinary session key unchanged", () => {
    expect(parseCacheStableSessionScope("agent:main:telegram:direct:42")).toEqual({
      baseSessionKey: "agent:main:telegram:direct:42",
      isVolatile: false,
    });
    expect(parseCacheStableSessionScope(undefined)).toEqual({
      baseSessionKey: undefined,
      isVolatile: false,
    });
  });

  it("never truncates a key that merely embeds a run marker", () => {
    expect(parseCacheStableSessionScope("agent:main:telegram:group:run:77").baseSessionKey).toBe(
      "agent:main:telegram:group:run:77",
    );
  });
});
