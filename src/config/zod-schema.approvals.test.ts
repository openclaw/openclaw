import { describe, expect, it } from "vitest";
import { ApprovalsSchema } from "./zod-schema.approvals.js";

describe("plugin Slack reviewer policy", () => {
  it("preserves omitted and empty defaults and requires workspace-qualified user IDs", () => {
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
    expect(
      ApprovalsSchema.safeParse({ plugin: { slack: { approvers: ["U12345678"] } } }).success,
    ).toBe(false);
    expect(ApprovalsSchema.safeParse({ plugin: { slack: { approvers: ["*"] } } }).success).toBe(
      false,
    );
  });
});
