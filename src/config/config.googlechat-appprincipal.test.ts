import { describe, expect, it } from "vitest";
import { GoogleChatConfigSchema } from "./zod-schema.providers-googlechat.js";

describe('GoogleChat appPrincipal required when audienceType is "app-url"', () => {
  it("accepts app-url with appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      audienceType: "app-url",
      appPrincipal: "123456789012345678901",
    });
    expect(result.success).toBe(true);
  });

  it("rejects app-url without appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      audienceType: "app-url",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("appPrincipal"))).toBe(true);
    }
  });

  it("rejects app-url with empty appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      audienceType: "app-url",
      appPrincipal: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("appPrincipal"))).toBe(true);
    }
  });

  it("accepts project-number without appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      audienceType: "project-number",
    });
    expect(result.success).toBe(true);
  });

  it("rejects account app-url without appPrincipal when parent has no audienceType", () => {
    const result = GoogleChatConfigSchema.safeParse({
      accounts: {
        work: {
          audienceType: "app-url",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.includes("accounts") && issue.path.includes("appPrincipal"),
        ),
      ).toBe(true);
    }
  });

  it("accepts account app-url with appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      accounts: {
        work: {
          audienceType: "app-url",
          appPrincipal: "123456789012345678901",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts account project-number without appPrincipal", () => {
    const result = GoogleChatConfigSchema.safeParse({
      accounts: {
        work: {
          audienceType: "project-number",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("inherits parent audienceType for account validation", () => {
    const result = GoogleChatConfigSchema.safeParse({
      audienceType: "app-url",
      appPrincipal: "123456789012345678901",
      accounts: {
        work: {},
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.includes("accounts") && issue.path.includes("appPrincipal"),
        ),
      ).toBe(true);
    }
  });
});
