import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { CloudWorkersConfigSchema } from "../../../../src/config/zod-schema.cloud-workers.js";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  cloudWorkerProfileStatus,
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
  it.each([undefined, ""])("requires an explicit class for an empty draft (%j)", (machineClass) => {
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

  it("distinguishes empty, advertised, and restart-required profiles", () => {
    expect(readCloudWorkerProfiles({})).toEqual([]);
    expect(
      readCloudWorkerProfiles({ cloudWorkers: { profiles: { production: configuredProfile } } }),
    ).toEqual([
      {
        id: "production",
        providerId: "crabbox",
        install: "npm",
        backend: "aws",
        target: "linux",
        machineClass: "beast",
        ttl: "24h",
        idleTimeout: "60m",
        setup: "install-node",
        setupEnv: "QA_WORKER_FLAG",
        warmImage: "auto",
        readyWorkers: "",
        suspendAfter: "30m",
        desktop: true,
        binary: "/opt/crabbox",
      },
    ]);
    expect(cloudWorkerProfileStatus("production", new Set(), false)).toBe("loading");
    expect(cloudWorkerProfileStatus("production", new Set(["production"]), true)).toBe(
      "advertised",
    );
    expect(cloudWorkerProfileStatus("production", new Set(), true)).toBe("restart-required");
  });

  it.each([
    ["profileId", { id: "bad id" }],
    ["profileExists", { id: "production" }],
    ["backend", { backend: " " }],
    ["target", { target: "x".repeat(65) }],
    ["target", { target: " linux " }],
    ...["macos", "windows/wsl2", "windows/normal"].map(
      (target) => ["warmImage", { target, warmImage: "on" }] as const,
    ),
    ["machineClass", { machineClass: "" }],
    ["machineClass", { machineClass: "x".repeat(129) }],
    ["ttl", { ttl: "tomorrow" }],
    ["idleTimeout", { idleTimeout: "0m" }],
    ["binary", { binary: "relative/crabbox" }],
    ...["-1", "1.5", "Infinity", "9007199254740992"].map(
      (readyWorkers) => ["readyWorkers", { readyWorkers }] as const,
    ),
    ...[
      "A A",
      "A,1BAD",
      "A-B",
      "CRABBOX_ENV_ALLOW",
      Array.from({ length: 17 }, (_, index) => `VAR_${index}`).join(","),
    ].map((setupEnv) => ["setupEnv", { setup: "true", setupEnv }] as const),
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

  it.each(["standard", "fast", "large", "beast", "custom", "batch/ARM64.v2", "x".repeat(128)])(
    "preserves class %s and hidden settings when backend and binary change",
    (machineClass) => {
      const profile = {
        ...configuredProfile,
        settings: { ...configuredProfile.settings, class: machineClass },
      };
      const config = { cloudWorkers: { profiles: { production: profile } } };
      const draft = {
        ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]),
        backend: "hetzner",
        binary: "/opt/crabbox-next",
      };
      const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
      expect(applyMergePatch(config, built.patch)).toEqual({
        cloudWorkers: {
          profiles: {
            production: {
              ...profile,
              settings: {
                ...profile.settings,
                provider: "hetzner",
                binary: "/opt/crabbox-next",
              },
            },
          },
        },
      });
      expect(built.replacePaths).toEqual(["cloudWorkers.profiles.production.settings.setupEnv"]);
    },
  );

  it.each([{ setupEnv: undefined }, { setupEnv: [] }])(
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
      name: "changes provider",
      replacement: {
        provider: "static-ssh",
        settings: { host: "worker.example.test", user: "openclaw" },
      },
    },
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
      install: "bundle",
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

  it.each(["macos", "windows/wsl2", "retired-os"])(
    "preserves provider-owned target %s and clears it through merge patch",
    (target) => {
      const config = {
        cloudWorkers: {
          profiles: {
            production: {
              ...configuredProfile,
              settings: { ...configuredProfile.settings, target },
            },
          },
        },
      };
      const draft = createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]);
      expect(draft.target).toBe(target);
      const retained = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
      expect(applyMergePatch(config, retained.patch)).toEqual(config);
      const cleared = requirePatch(
        buildCloudWorkerUpsertPatch(config, { ...draft, target: "" }, "production"),
      );
      const next = applyMergePatch(config, cleared.patch);
      expect(next).not.toHaveProperty("cloudWorkers.profiles.production.settings.target");
    },
  );

  it("adds only the new profile without resending existing profiles", () => {
    const config = { cloudWorkers: { profiles: { production: configuredProfile } } };
    const draft = {
      ...createCloudWorkerDraft(),
      id: "build-fleet",
      backend: "hetzner",
      machineClass: "standard",
    };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, null));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            "build-fleet": {
              provider: "crabbox",
              install: "bundle",
              readyWorkers: null,
              suspendAfter: null,
              settings: {
                provider: "hetzner",
                target: null,
                class: "standard",
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
      replacePaths: [],
    });
    expect(applyMergePatch(config, built.patch)).toMatchObject(config);
  });

  it.each([
    ["+1h", false],
    [".5h", false],
    ["1m1us", false],
    ["59s", false],
    ["60s", true],
    ["45m", true],
    ["2h", true],
    ["1d", true],
    ["1H", true],
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

  it.each(["auto", "on", "off"] as const)(
    "patches warm images as %s and replaces setup names",
    (warmImage) => {
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
      if (warmImage === "auto") {
        expect(merged).not.toHaveProperty("cloudWorkers.profiles.production.settings.warmImage");
      } else {
        expect(merged).toHaveProperty(
          "cloudWorkers.profiles.production.settings.warmImage",
          warmImage === "on",
        );
      }
    },
  );

  it.each(["", "linux", "macos", "windows/wsl2", "windows/normal"])(
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
