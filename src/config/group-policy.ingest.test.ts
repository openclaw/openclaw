import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelGroupIngest } from "./group-policy.js";

describe("resolveChannelGroupIngest", () => {
  it("prefers explicit group ingest over wildcard default", () => {
    const cfg = {
      channels: {
        signal: {
          groups: {
            "*": { ingest: true },
            "group-1": { ingest: false },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveChannelGroupIngest({
        cfg,
        channel: "signal",
        groupId: "group-1",
      }),
    ).toBe(false);
  });

  it("falls back to wildcard ingest for unmatched groups", () => {
    const cfg = {
      channels: {
        signal: {
          groups: {
            "*": { ingest: true },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveChannelGroupIngest({
        cfg,
        channel: "signal",
        groupId: "group-2",
      }),
    ).toBe(true);
  });
});
