import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function cloudProfile(profile: Record<string, unknown>) {
  return { cloudWorkers: { profiles: { development: { provider: "qa-lab", ...profile } } } };
}

describe("OpenClawSchema cloudWorkers config", () => {
  it.each([{ "github.com/acme/app": " " }, { "github.com/acme": "development" }])(
    "rejects invalid per-project profile mappings %#",
    (projectProfiles) => {
      expect(OpenClawSchema.safeParse({ cloudWorkers: { projectProfiles } }).success).toBe(false);
    },
  );

  it("accepts provider-owned settings with SecretRefs and defaults to bundled installation", () => {
    const settings = {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      keyRef: { source: "file", provider: "default", id: "/cloud-workers/development/privateKey" },
    };
    expect(
      OpenClawSchema.parse(cloudProfile({ provider: "static-ssh", settings })).cloudWorkers,
    ).toStrictEqual({
      profiles: { development: { provider: "static-ssh", install: "bundle", settings } },
    });
  });

  it("rejects a malformed idle suspend duration", () => {
    expect(OpenClawSchema.safeParse(cloudProfile({ suspendAfter: "-1m" })).success).toBe(false);
  });

  it("rejects non-finite provider settings", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { timeout: Infinity } })).success,
    ).toBe(false);
  });

  it("rejects nested plaintext provider secrets", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { auth: { apiKey: "plain-api-key" } } }))
        .success,
    ).toBe(false);
  });
});
