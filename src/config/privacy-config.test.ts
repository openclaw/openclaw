import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("privacy config schema", () => {
  it("accepts a valid privacy config", () => {
    const parsed = OpenClawSchema.parse({
      privacy: {
        enabled: true,
        rules: "extended",
        encryption: {
          algorithm: "aes-256-gcm",
          salt: "test-salt",
        },
        mappings: {
          ttl: 86_400_000,
          storePath: "/tmp/privacy-mappings.enc",
          lockWaitTimeoutMs: 5_000,
          lockStaleAfterMs: 60_000,
        },
        log: {
          useReplacedContent: true,
        },
      },
    });
    expect(parsed.privacy?.enabled).toBe(true);
    expect(parsed.privacy?.mappings?.ttl).toBe(86_400_000);
    expect(parsed.privacy?.mappings?.lockWaitTimeoutMs).toBe(5_000);
  });

  it("rejects invalid ttl", () => {
    const result = OpenClawSchema.safeParse({
      privacy: {
        mappings: {
          ttl: 0,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid lock timeout", () => {
    const result = OpenClawSchema.safeParse({
      privacy: {
        mappings: {
          lockWaitTimeoutMs: 0,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
