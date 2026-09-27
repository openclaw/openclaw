import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../../config/zod-schema.js";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto", () => {
    expect(resolveSkillWorkshopConfig().autonomous.mode).toBe("auto");
  });

  it.each(["off", "propose"] as const)("reads autonomous mode %s", (mode) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { workshop: { autonomous: { mode } } } }).autonomous
        .mode,
    ).toBe(mode);
  });

  it("does not read the retired boolean key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { enabled: false } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });

  it("defaults review overflow handling to skip without a context cap", () => {
    expect(resolveSkillWorkshopConfig().autonomous).toEqual({
      mode: "auto",
      overflowPolicy: "skip",
    });
  });

  it("reads explicit review context limits and overflow policy", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: {
          workshop: {
            autonomous: {
              maxReviewContextTokens: 12_000,
              maxReviewContextBytes: 2_048,
              overflowPolicy: "fail",
            },
          },
        },
      }).autonomous,
    ).toEqual({
      mode: "auto",
      maxReviewContextTokens: 12_000,
      maxReviewContextBytes: 2_048,
      overflowPolicy: "fail",
    });
  });

  it("drops malformed review context limits and unknown overflow policies", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: {
          workshop: {
            autonomous: {
              maxReviewContextTokens: 100,
              maxReviewContextBytes: Number.NaN,
              overflowPolicy: "compact",
            },
          },
        },
      } as never).autonomous,
    ).toEqual({ mode: "auto", overflowPolicy: "skip" });
  });

  it("validates review context limits against schema bounds", () => {
    expect(
      OpenClawSchema.safeParse({
        skills: {
          workshop: {
            autonomous: {
              maxReviewContextTokens: 2_000_000,
              maxReviewContextBytes: 256 * 1024 * 1024,
            },
          },
        },
      }).success,
    ).toBe(true);

    expect(
      OpenClawSchema.safeParse({
        skills: {
          workshop: {
            autonomous: {
              maxReviewContextTokens: 2_000_001,
            },
          },
        },
      }).success,
    ).toBe(false);

    expect(
      OpenClawSchema.safeParse({
        skills: {
          workshop: {
            autonomous: {
              maxReviewContextBytes: 256 * 1024 * 1024 + 1,
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});
