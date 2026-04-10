import { describe, expect, it } from "vitest";
import { buildCompactionResetReplyText } from "./compaction-reset-reply.js";

describe("buildCompactionResetReplyText", () => {
  it("suggests raising reserveTokensFloor when below the default floor", () => {
    const text = buildCompactionResetReplyText({
      duringCompaction: true,
      config: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 8_000,
            },
          },
        },
      },
    });

    expect(text).toContain("Context limit exceeded during compaction");
    expect(text).toContain("agents.defaults.compaction.reserveTokensFloor");
    expect(text).toContain("20000 or higher");
  });

  it("avoids stale reserveTokensFloor advice when the floor is already high", () => {
    const text = buildCompactionResetReplyText({
      duringCompaction: false,
      config: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: 50_000,
            },
          },
        },
      },
    });

    expect(text).toContain("Context limit exceeded.");
    expect(text).toContain("agents.defaults.compaction.model");
    expect(text).not.toContain("20000 or higher");
  });
});
