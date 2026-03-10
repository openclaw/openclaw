import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("Slack binding peer id warnings", () => {
  it("warns but accepts target-style Slack channel peer ids", () => {
    const result = validateConfigObjectWithPlugins({
      bindings: [
        {
          agentId: "gemini",
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "channel:C123456" },
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "bindings.0.match.peer.id",
          message: expect.stringContaining('normalize "channel:C123456" to "C123456"'),
        }),
      ]),
    );
  });

  it("does not warn for raw Slack peer ids", () => {
    const result = validateConfigObjectWithPlugins({
      bindings: [
        {
          agentId: "gemini",
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "C123456" },
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
