import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityLookupFromEnv } from "./lookup.js";

describe("createIdentityLookupFromEnv", () => {
  const originalLookupUrl = process.env.OPENCLAW_IDENTITY_LOOKUP_URL;
  const originalLookupToken = process.env.OPENCLAW_IDENTITY_LOOKUP_TOKEN;
  const originalLookupTimeout = process.env.OPENCLAW_IDENTITY_LOOKUP_TIMEOUT_MS;

  afterEach(() => {
    if (originalLookupUrl === undefined) {
      delete process.env.OPENCLAW_IDENTITY_LOOKUP_URL;
    } else {
      process.env.OPENCLAW_IDENTITY_LOOKUP_URL = originalLookupUrl;
    }
    if (originalLookupToken === undefined) {
      delete process.env.OPENCLAW_IDENTITY_LOOKUP_TOKEN;
    } else {
      process.env.OPENCLAW_IDENTITY_LOOKUP_TOKEN = originalLookupToken;
    }
    if (originalLookupTimeout === undefined) {
      delete process.env.OPENCLAW_IDENTITY_LOOKUP_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_IDENTITY_LOOKUP_TIMEOUT_MS = originalLookupTimeout;
    }
  });

  it("returns normalized candidates from remote endpoint", async () => {
    process.env.OPENCLAW_IDENTITY_LOOKUP_URL = "https://identity.example/lookup";
    process.env.OPENCLAW_IDENTITY_LOOKUP_TOKEN = "secret";

    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              subjectId: "owner_1",
              role: "owner",
              allowedPropertyIds: ["prop_1"],
              allowedUnitIds: ["402"],
              allowedWorkOrderIds: ["wo_7"],
              lastVerifiedAtMs: 1_000,
              identityConfidence: "high",
            },
          ],
        }),
      } as unknown as Response;
    });

    const lookup = createIdentityLookupFromEnv({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const candidates = await lookup({
      channel: "email",
      channelIdentity: "owner@example.com",
      intentSlug: "what_is_my_current_balance",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subjectId).toBe("owner_1");
    expect(candidates[0]?.allowedUnitIds).toEqual(["402"]);
  });

  it("returns empty list for malformed candidate payload", async () => {
    process.env.OPENCLAW_IDENTITY_LOOKUP_URL = "https://identity.example/lookup";

    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ candidates: [{ role: "owner" }] }),
      } as unknown as Response;
    });

    const lookup = createIdentityLookupFromEnv({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const candidates = await lookup({
      channel: "sms",
      channelIdentity: "+13055551212",
      intentSlug: "update_work_order_status",
    });

    expect(candidates).toEqual([]);
  });

  it("returns empty list for non-ok endpoint responses", async () => {
    process.env.OPENCLAW_IDENTITY_LOOKUP_URL = "https://identity.example/lookup";

    const fetchImpl = vi.fn(async () => {
      return {
        ok: false,
        status: 503,
      } as unknown as Response;
    });

    const lookup = createIdentityLookupFromEnv({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const candidates = await lookup({
      channel: "email",
      channelIdentity: "vendor@example.com",
      intentSlug: "hook_message",
    });

    expect(candidates).toEqual([]);
  });
});
