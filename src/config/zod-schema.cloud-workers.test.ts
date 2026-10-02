import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function cloudProfile(profile: Record<string, unknown>) {
  return { cloudWorkers: { profiles: { development: { provider: "qa-lab", ...profile } } } };
}

describe("OpenClawSchema cloudWorkers config", () => {
  it("accepts normalized per-project default profiles", () => {
    const projectProfiles = { "github.com/acme/app": "development" };
    expect(OpenClawSchema.parse({ cloudWorkers: { projectProfiles } }).cloudWorkers).toStrictEqual({
      projectProfiles,
    });
  });

  it.each([
    { "github.com/acme/app": " " },
    { "GitHub.com/acme/app": "development" },
    { "github.com/acme": "development" },
  ])("rejects invalid per-project profile mappings %#", (projectProfiles) => {
    expect(OpenClawSchema.safeParse({ cloudWorkers: { projectProfiles } }).success).toBe(false);
  });

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

  it("accepts the minimum idle suspend duration", () => {
    expect(OpenClawSchema.parse(cloudProfile({ suspendAfter: "1m" })).cloudWorkers).toStrictEqual({
      profiles: { development: { provider: "qa-lab", install: "bundle", suspendAfter: "1m" } },
    });
  });

  it.each(["59s", "-1m", "60000"])(
    "rejects an invalid or sub-minute idle suspend duration: %s",
    (suspendAfter) => {
      expect(OpenClawSchema.safeParse(cloudProfile({ suspendAfter })).success).toBe(false);
    },
  );

  it("rejects non-finite provider settings", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { timeout: Infinity } })).success,
    ).toBe(false);
  });

  it.each([{ keyRef: "plain-private-key" }, { auth: { apiKey: "plain-api-key" } }])(
    "rejects plaintext provider secrets at any depth: %j",
    (settings) => {
      expect(OpenClawSchema.safeParse(cloudProfile({ settings })).success).toBe(false);
    },
  );
});
