import { describe, expect, it } from "vitest";
import { applyTargetToParams } from "./channel-target.js";

describe("applyTargetToParams", () => {
  it("maps trimmed target values into the configured target field", () => {
    const toParams = {
      action: "send",
      args: { target: "  channel:C1  " } as Record<string, unknown>,
    };
    applyTargetToParams(toParams);
    expect(toParams.args.to).toBe("channel:C1");

    const channelIdParams = {
      action: "channel-info",
      args: { target: "  C123  " } as Record<string, unknown>,
    };
    applyTargetToParams(channelIdParams);
    expect(channelIdParams.args.channelId).toBe("C123");
  });

  it("throws on legacy destination fields when the action has canonical target support", () => {
    expect(() =>
      applyTargetToParams({
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
        },
      }),
    ).toThrow("Use `target` instead of `to`/`channelId`.");
  });

  it("throws when a no-target action receives target or legacy destination fields", () => {
    expect(() =>
      applyTargetToParams({
        action: "broadcast",
        args: {
          to: "legacy",
        },
      }),
    ).toThrow("Use `target` for actions that accept a destination.");

    expect(() =>
      applyTargetToParams({
        action: "broadcast",
        args: {
          target: "channel:C1",
        },
      }),
    ).toThrow("Action broadcast does not accept a target.");
  });

  it("does nothing when target is blank", () => {
    const params = {
      action: "send",
      args: { target: "   " } as Record<string, unknown>,
    };

    applyTargetToParams(params);

    expect(params.args).toEqual({ target: "   " });
  });
});
