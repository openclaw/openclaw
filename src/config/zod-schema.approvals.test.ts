import { describe, expect, it } from "vitest";
import { ApprovalsSchema } from "./zod-schema.approvals.js";

describe("plugin Slack reviewer policy", () => {
  it("preserves omitted and empty defaults and rejects wildcard reviewers", () => {
    expect(ApprovalsSchema.parse({ plugin: { slack: { approvers: [] } } })).toEqual({
      plugin: { slack: { approvers: [] } },
    });
    expect(
      ApprovalsSchema.parse({
        plugin: {
          slack: {
            plugins: {
              calendar: { approvers: ["team:T12345678:user:U12345678"] },
            },
          },
        },
      })?.plugin?.slack?.approvers,
    ).toBeUndefined();
    expect(ApprovalsSchema.safeParse({ plugin: { slack: { approvers: ["*"] } } }).success).toBe(
      false,
    );
  });

  it.each(["U12345678", "W12345678", "team:T12345678:user:U12345678"])(
    "accepts stable Slack user ID %s at every policy level",
    (reviewer) => {
      const config = {
        plugin: {
          slack: {
            approvers: [reviewer],
            plugins: {
              calendar: {
                approvers: [reviewer],
                tools: { "create%20event": { approvers: [reviewer] } },
              },
            },
          },
        },
      };
      expect(ApprovalsSchema.parse(config)).toEqual(config);
    },
  );
});
