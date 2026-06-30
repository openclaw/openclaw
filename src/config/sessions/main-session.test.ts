import { describe, expect, it } from "vitest";
import { resolveMainSessionKey } from "./main-session.js";

describe("resolveMainSessionKey", () => {
  it("returns default main key when no agents configured", () => {
    expect(resolveMainSessionKey({}, {})).toBe("agent:main:main");
  });

  it("uses agents.defaultAgentId when list is absent", () => {
    expect(resolveMainSessionKey({ agents: { defaultAgentId: "ops" } }, {})).toBe("agent:ops:main");
  });

  it("uses agents.defaultAgentId when list is empty", () => {
    expect(resolveMainSessionKey({ agents: { list: [], defaultAgentId: "ops" } }, {})).toBe(
      "agent:ops:main",
    );
  });

  it("first agents.list entry takes precedence over defaultAgentId", () => {
    expect(
      resolveMainSessionKey({ agents: { list: [{ id: "alpha" }], defaultAgentId: "ops" } }, {}),
    ).toBe("agent:alpha:main");
  });

  it("agents.list default:true entry wins over first entry", () => {
    expect(
      resolveMainSessionKey(
        {
          agents: {
            list: [{ id: "alpha" }, { id: "beta", default: true }],
            defaultAgentId: "ops",
          },
        },
        {},
      ),
    ).toBe("agent:beta:main");
  });

  it("falls back to OPENCLAW_DEFAULT_AGENT_ID env when no agents and no config defaultAgentId", () => {
    expect(resolveMainSessionKey({}, { OPENCLAW_DEFAULT_AGENT_ID: "envagent" })).toBe(
      "agent:envagent:main",
    );
  });

  it("config defaultAgentId takes precedence over OPENCLAW_DEFAULT_AGENT_ID env", () => {
    expect(
      resolveMainSessionKey(
        { agents: { defaultAgentId: "cfgagent" } },
        { OPENCLAW_DEFAULT_AGENT_ID: "envagent" },
      ),
    ).toBe("agent:cfgagent:main");
  });

  it("respects global scope regardless of agent config", () => {
    expect(
      resolveMainSessionKey(
        { session: { scope: "global" }, agents: { defaultAgentId: "ops" } },
        {},
      ),
    ).toBe("global");
  });

  it("incorporates custom mainKey", () => {
    expect(
      resolveMainSessionKey(
        { session: { mainKey: "mykey" }, agents: { defaultAgentId: "ops" } },
        {},
      ),
    ).toBe("agent:ops:mykey");
  });
});
