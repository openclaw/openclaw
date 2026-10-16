import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { CloudWorkersConfigSchema } from "../../../../src/config/zod-schema.cloud-workers.js";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
} from "./cloud-worker-config.ts";

const configuredProfile = {
  provider: "crabbox",
  install: "npm",
  suspendAfter: "30m",
  settings: {
    provider: "aws",
    target: "linux",
    class: "beast",
    ttl: "24h",
    idleTimeout: "60m",
    setup: "install-node",
    setupEnv: ["QA_WORKER_FLAG"],
    desktop: true,
    binary: "/opt/crabbox",
    opaque: { nullable: null, flags: ["kept"] },
  },
};

function requirePatch(result: ReturnType<typeof buildCloudWorkerUpsertPatch>) {
  if ("error" in result) {
    throw new Error(`Unexpected profile patch error: ${result.error}`);
  }
  return result;
}

describe("cloud worker settings state", () => {
  it.each([undefined])("requires an explicit class for an empty draft (%j)", (machineClass) => {
    const profile = readCloudWorkerProfiles({
      cloudWorkers: {
        profiles: {
          production: {
            ...configuredProfile,
            settings: { ...configuredProfile.settings, class: machineClass },
          },
        },
      },
    })[0];
    const draft = createCloudWorkerDraft(machineClass === undefined ? undefined : profile);
    expect(draft.machineClass).toBe("");
    expect(
      validateCloudWorkerDraft({ ...draft, id: "new-profile", backend: "hetzner" }, {}, null),
    ).toBe("machineClass");
  });

  it.each([
    ["profileId", { id: "bad id" }],
    ["profileExists", { id: "production" }],
    ["backend", { backend: " " }],
    ["target", { target: "x".repeat(65) }],
    ["ttl", { ttl: "tomorrow" }],
    ["idleTimeout", { idleTimeout: "0m" }],
    ["binary", { binary: "relative/crabbox" }],
    ["readyWorkers", { readyWorkers: "9007199254740992" }],
    ["setupEnv", { setup: "true", setupEnv: "CRABBOX_ENV_ALLOW" }],
    ["setupEnvRequiresSetup", { setupEnv: "BUILD_FLAG" }],
  ] as const)("returns %s for an invalid add draft", (expected, patch) => {
    const draft = {
      ...createCloudWorkerDraft(),
      id: "new-profile",
      backend: "hetzner",
      machineClass: "standard",
      ...patch,
    };
    expect(validateCloudWorkerDraft(draft, { production: configuredProfile }, null)).toBe(expected);
  });

  it("clears setup with exact array intent while preserving opaque fields", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = {
      ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
      backend: "hetzner",
      machineClass: "large",
      ttl: "8h",
      idleTimeout: "45m",
      setup: "",
      setupEnv: "",
      desktop: false,
      binary: "",
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            production: {
              provider: "crabbox",
              install: "npm",
              readyWorkers: null,
              suspendAfter: "30m",
              settings: {
                provider: "hetzner",
                target: "linux",
                class: "large",
                ttl: "8h",
                idleTimeout: "45m",
                setup: null,
                setupEnv: null,
                warmImage: null,
                desktop: null,
                binary: null,
              },
            },
          },
        },
      },
      replacePaths: ["cloudWorkers.profiles.production.settings.setupEnv"],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        profiles: {
          production: {
            provider: "crabbox",
            install: "npm",
            suspendAfter: "30m",
            settings: {
              provider: "hetzner",
              target: "linux",
              class: "large",
              ttl: "8h",
              idleTimeout: "45m",
              opaque: configuredProfile.settings.opaque,
            },
          },
        },
      },
    });
  });

  it.each([{ setupEnv: undefined }])(
    "omits empty setup environment ($setupEnv)",
    ({ setupEnv }) => {
      const { setupEnv: _setupEnv, ...settings } = configuredProfile.settings;
      const existingSettings = { ...settings, ...(setupEnv ? { setupEnv } : {}) };
      const profile = { ...configuredProfile, settings: existingSettings };
      const config = { cloudWorkers: { profiles: { production: profile } } };
      const draft = { ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]), setup: "" };
      const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
      const { setup: _setup, setupEnv: _emptyEnv, ...retainedSettings } = existingSettings;
      expect(applyMergePatch(config, built.patch)).toEqual({
        cloudWorkers: {
          profiles: { production: { ...profile, settings: retainedSettings } },
        },
      });
      expect(built.replacePaths).toEqual(
        setupEnv ? ["cloudWorkers.profiles.production.settings.setupEnv"] : [],
      );
    },
  );

  it.each([
    {
      name: "removes its class",
      replacement: {
        provider: "crabbox",
        settings: { provider: "hetzner", ttl: "8h", idleTimeout: "45m", warmImage: false },
      },
    },
  ])("rejects an edit after its authoritative profile $name", ({ replacement }) => {
    const config = { cloudWorkers: { profiles: { production: replacement } } };
    const draft = createCloudWorkerDraft({
      ...createCloudWorkerDraft(),
      id: "production",
      providerId: "crabbox",
      backend: "aws",
      target: "linux",
      machineClass: "standard",
      ttl: "8h",
      idleTimeout: "45m",
      setup: "",
      desktop: false,
      binary: "",
    });
    expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toEqual({
      error: "profileMissing",
    });
  });

  it.each([
    ["1m1us", false],
    ["59s", false],
  ] as const)("matches the suspendAfter schema for %s", (suspendAfter, accepted) => {
    const draft = {
      ...createCloudWorkerDraft(),
      id: "test",
      backend: "aws",
      machineClass: "standard",
      suspendAfter,
    };
    expect(
      CloudWorkersConfigSchema.safeParse({
        profiles: { test: { provider: "crabbox", suspendAfter } },
      }).success,
    ).toBe(accepted);
    expect(validateCloudWorkerDraft(draft, {}, null)).toBe(accepted ? null : "suspendAfter");
  });

  it.each(["on"] as const)("patches warm images as %s and replaces setup names", (warmImage) => {
    const config = {
      cloudWorkers: {
        profiles: {
          production: {
            ...configuredProfile,
            readyWorkers: 3,
            settings: { ...configuredProfile.settings, warmImage: true },
          },
        },
      },
    };
    const draft = {
      ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
      warmImage,
      setupEnv: "BUILD_FLAG, CACHE_MODE\nEXTRA",
      readyWorkers: "0",
      suspendAfter: "2h",
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
    const merged = applyMergePatch(config, built.patch);
    expect(merged).toHaveProperty("cloudWorkers.profiles.production.readyWorkers", 0);
    expect(merged).toHaveProperty("cloudWorkers.profiles.production.suspendAfter", "2h");
    expect(merged).toHaveProperty("cloudWorkers.profiles.production.settings.setupEnv", [
      "BUILD_FLAG",
      "CACHE_MODE",
      "EXTRA",
    ]);
    expect(built.replacePaths).toEqual(["cloudWorkers.profiles.production.settings.setupEnv"]);
    expect(merged).toHaveProperty("cloudWorkers.profiles.production.settings.warmImage", true);
  });

  it.each(["windows/wsl2"])(
    "validates warm images after changing an existing profile target to %s",
    (target) => {
      const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
      for (const warmImage of ["auto", "on", "off"] as const) {
        const draft = {
          ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
          target,
          warmImage,
        };
        const built = buildCloudWorkerUpsertPatch(config, draft, "production");
        if (warmImage === "on" && target && target !== "linux") {
          expect(built).toEqual({ error: "warmImage" });
        } else {
          expect(requirePatch(built).patch).toHaveProperty(
            "cloudWorkers.profiles.production.settings.warmImage",
            warmImage === "auto" ? null : warmImage === "on",
          );
        }
      }
    },
  );

  it("accepts sixteen setup names without dropping or reordering them", () => {
    const names = Array.from({ length: 16 }, (_, index) => `BUILD_${index}`);
    const draft = {
      ...createCloudWorkerDraft(),
      id: "build",
      backend: "aws",
      machineClass: "standard",
      setup: "true",
      setupEnv: names.join(" , "),
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch({}, draft, null));
    expect(built.patch).toHaveProperty("cloudWorkers.profiles.build.settings.setupEnv", names);
  });

  it("removes cleared advanced fields while retaining the rest of the profile", () => {
    const profile = {
      ...configuredProfile,
      readyWorkers: 2,
      settings: { ...configuredProfile.settings, warmImage: false },
    };
    const config = { cloudWorkers: { profiles: { production: profile } } };
    const draft = {
      ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
      readyWorkers: "",
      suspendAfter: "",
      warmImage: "auto" as const,
      setupEnv: "",
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
    expect(built.patch).toMatchObject({
      cloudWorkers: {
        profiles: {
          production: {
            readyWorkers: null,
            suspendAfter: null,
            settings: { warmImage: null, setupEnv: null },
          },
        },
      },
    });
    const merged = applyMergePatch(config, built.patch);
    for (const path of [
      "readyWorkers",
      "suspendAfter",
      "settings.warmImage",
      "settings.setupEnv",
    ]) {
      expect(merged).not.toHaveProperty(`cloudWorkers.profiles.production.${path}`);
    }
    expect(merged).toHaveProperty(
      "cloudWorkers.profiles.production.settings.opaque",
      configuredProfile.settings.opaque,
    );
    expect(merged).toHaveProperty("cloudWorkers.profiles.production.install", "npm");
  });

  it("deletes only the target and its project defaults with exact array intent", () => {
    const deleted = {
      ...configuredProfile,
      settings: { ...configuredProfile.settings, empty: [] },
    };
    const config = {
      cloudWorkers: {
        profiles: { production: deleted, retained: configuredProfile },
        projectProfiles: {
          "github.com/acme/app": "production",
          "github.com/acme/docs": "production",
          "github.com/acme/retained": "retained",
        },
      },
    };
    const built = requirePatch(buildCloudWorkerDeletePatch(config, "production"));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: { production: null },
          projectProfiles: {
            "github.com/acme/app": null,
            "github.com/acme/docs": null,
          },
        },
      },
      replacePaths: [
        "cloudWorkers.profiles.production.settings.setupEnv",
        "cloudWorkers.profiles.production.settings.opaque.flags",
        "cloudWorkers.profiles.production.settings.empty",
      ],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        profiles: { retained: configuredProfile },
        projectProfiles: { "github.com/acme/retained": "retained" },
      },
    });
  });
});
