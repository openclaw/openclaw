import { describe, expect, it } from "vitest";
import { resolveMentionedAgentId } from "./mentions.js";

const cfg = {
  agents: {
    entries: {
      researcher: {
        name: "Researcher",
        identity: { name: "Researcher", theme: "AXWEL", title: "Research" },
      },
      writer: { name: "Writer", identity: { name: "Writer", theme: "AXWEL" } },
      ops: { name: "Ops", identity: { name: "Ops" } },
    },
  },
};

describe("teammate bot mentions", () => {
  it("routes @Researcher to the researcher bot without using theme as a slogan mention", () => {
    expect(resolveMentionedAgentId(cfg, "hey @Researcher pull signups")?.agentId).toBe(
      "researcher",
    );
    expect(resolveMentionedAgentId(cfg, "talk to @AXWEL")).toBeUndefined();
  });

  it("routes @axwel-backend style ids", () => {
    const withId = {
      agents: {
        entries: {
          "axwel-backend": { identity: { name: "AXWEL backend" } },
          writer: { identity: { name: "Writer" } },
        },
      },
    };
    expect(resolveMentionedAgentId(withId, "@axwel-backend look at CI")?.agentId).toBe(
      "axwel-backend",
    );
  });

  it("leaves routing alone when two bots are mentioned", () => {
    expect(resolveMentionedAgentId(cfg, "@Researcher and @Writer please")).toBeUndefined();
  });
});
