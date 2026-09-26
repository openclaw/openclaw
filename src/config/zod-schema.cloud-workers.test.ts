// Verifies cloud-worker provider profile config parsing.
import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { CLOUD_WORKER_FIELD_HELP, CLOUD_WORKER_FIELD_LABELS } from "./zod-schema.cloud-workers.js";
import { OpenClawSchema } from "./zod-schema.js";

function parseCloudWorkers(value: unknown) {
  const result = OpenClawSchema.safeParse({ cloudWorkers: value });
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.cloudWorkers;
}

describe("OpenClawSchema cloudWorkers config", () => {
  it("derives cloud worker labels and help from the field schemas", () => {
    const response = computeBaseConfigSchemaResponse({ generatedAt: "cloud-worker-metadata" });
    const properties = (
      response.schema as {
        properties?: {
          cloudWorkers?: {
            title?: string;
            description?: string;
            properties?: {
              desktop?: {
                title?: string;
                description?: string;
              };
              projectProfiles?: {
                title?: string;
                description?: string;
                additionalProperties?: {
                  title?: string;
                  description?: string;
                };
              };
              profiles?: {
                title?: string;
                description?: string;
                additionalProperties?: {
                  title?: string;
                  description?: string;
                  properties?: Record<string, { title?: string; description?: string }>;
                };
              };
            };
          };
        };
      }
    ).properties?.cloudWorkers;
    const desktop = properties?.properties?.desktop;
    const projectProfiles = properties?.properties?.projectProfiles;
    const profiles = properties?.properties?.profiles;
    const profile = profiles?.additionalProperties;

    for (const [path, schema] of [
      ["cloudWorkers.desktop", desktop],
      ["cloudWorkers.projectProfiles", projectProfiles],
      ["cloudWorkers.projectProfiles.*", projectProfiles?.additionalProperties],
      ["cloudWorkers.profiles", profiles],
      ["cloudWorkers.profiles.*", profile],
      ["cloudWorkers.profiles.*.provider", profile?.properties?.provider],
      ["cloudWorkers.profiles.*.install", profile?.properties?.install],
      ["cloudWorkers.profiles.*.suspendAfter", profile?.properties?.suspendAfter],
      ["cloudWorkers.profiles.*.settings", profile?.properties?.settings],
    ] as const) {
      expect(schema?.title, path).toBe(CLOUD_WORKER_FIELD_LABELS[path]);
      expect(schema?.description, path).toBe(CLOUD_WORKER_FIELD_HELP[path]);
      expect(response.uiHints[path]?.label, path).toBe(schema?.title);
      expect(response.uiHints[path]?.help, path).toBe(schema?.description);
    }
  });

  it("is absent by default and accepts an empty opt-in block", () => {
    expect(OpenClawSchema.parse({}).cloudWorkers).toBeUndefined();
    expect(parseCloudWorkers({})).toStrictEqual({});
  });

  it("retains a required profile before enrollment without blocking startup", () => {
    expect(parseCloudWorkers({ requiredProfile: "not-enrolled-yet" })).toEqual({
      requiredProfile: "not-enrolled-yet",
    });
  });

  it.each(["", " ", " worker", "worker ", null, true, 3])(
    "rejects invalid required profile %j",
    (requiredProfile) => {
      expect(OpenClawSchema.safeParse({ cloudWorkers: { requiredProfile } }).success).toBe(false);
    },
  );

  it("accepts the desktop Labs gate only as a boolean", () => {
    expect(parseCloudWorkers({ desktop: true })).toStrictEqual({ desktop: true });
    expect(OpenClawSchema.safeParse({ cloudWorkers: { desktop: "true" } }).success).toBe(false);
  });

  it("accepts normalized per-project default profiles", () => {
    expect(
      parseCloudWorkers({
        projectProfiles: {
          "github.com/acme/app": "development",
        },
      }),
    ).toStrictEqual({
      projectProfiles: {
        "github.com/acme/app": "development",
      },
    });
  });

  it.each([
    { "github.com/acme/app": "" },
    { "github.com/acme/app": " " },
    { "github.com/acme/app": 42 },
    { "GitHub.com/acme/app": "development" },
    { "github.com/acme/app.git": "development" },
    { "github.com/acme": "development" },
  ])("rejects invalid per-project profile mappings %#", (projectProfiles) => {
    expect(OpenClawSchema.safeParse({ cloudWorkers: { projectProfiles } }).success).toBe(false);
  });

  it("accepts provider-owned settings", () => {
    expect(
      parseCloudWorkers({
        profiles: {
          development: {
            provider: "static-ssh",
            settings: {
              host: "worker.example.test",
              port: 22,
              user: "openclaw",
              keyRef: {
                source: "file",
                provider: "default",
                id: "/cloud-workers/development/privateKey",
              },
            },
          },
        },
      }),
    ).toStrictEqual({
      profiles: {
        development: {
          provider: "static-ssh",
          install: "bundle",
          settings: {
            host: "worker.example.test",
            port: 22,
            user: "openclaw",
            keyRef: {
              source: "file",
              provider: "default",
              id: "/cloud-workers/development/privateKey",
            },
          },
        },
      },
    });
  });

  it("accepts npm as an explicit install method", () => {
    expect(
      parseCloudWorkers({
        profiles: {
          released: {
            provider: "qa-lab",
            install: "npm",
          },
        },
      }),
    ).toStrictEqual({
      profiles: {
        released: {
          provider: "qa-lab",
          install: "npm",
        },
      },
    });
  });

  it.each(["1m", "1h30m"])(
    "accepts an idle suspend duration of at least one minute: %s",
    (suspendAfter) => {
      expect(
        parseCloudWorkers({ profiles: { development: { provider: "qa-lab", suspendAfter } } }),
      ).toStrictEqual({
        profiles: { development: { provider: "qa-lab", install: "bundle", suspendAfter } },
      });
    },
  );

  it.each(["59s", "-1m", "60000", 60_000])(
    "rejects an invalid or sub-minute idle suspend duration: %s",
    (suspendAfter) => {
      const result = OpenClawSchema.safeParse({
        cloudWorkers: { profiles: { development: { provider: "qa-lab", suspendAfter } } },
      });
      expect(result.success).toBe(false);
    },
  );

  it.each([
    { profiles: { development: { provider: "" } } },
    { profiles: { development: { provider: "qa-lab", install: "git" } } },
    { profiles: { " development ": { provider: "qa-lab" } } },
    { profiles: { development: { provider: "qa-lab", settings: { timeout: Infinity } } } },
    { profiles: { development: { provider: "qa-lab", settings: { region: undefined } } } },
    {
      profiles: {
        development: { provider: "qa-lab", settings: { keyRef: "plain-private-key" } },
      },
    },
    {
      profiles: {
        development: { provider: "qa-lab", settings: { auth: { apiKey: "plain-api-key" } } },
      },
    },
    { profiles: { development: { provider: "qa-lab", lifetime: { idleTimeoutMinutes: 0 } } } },
    {
      profiles: {
        development: { provider: "qa-lab", lifetime: { maxLifetimeMinutes: 1.5 } },
      },
    },
    { profiles: { development: { provider: "qa-lab", unsupported: true } } },
  ])("rejects invalid core profile fields %#", (cloudWorkers) => {
    expect(OpenClawSchema.safeParse({ cloudWorkers }).success).toBe(false);
  });
});
