import { expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { CloudWorkersConfigSchema } from "../../../../src/config/zod-schema.cloud-workers.js";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
  type CloudWorkerProfileDraft,
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

const {
  setup: _setup,
  setupEnv: _env,
  desktop: _desktop,
  binary: _binary,
  ...baseSettings
} = configuredProfile.settings;
const { setupEnv: _setupEnv, ...settingsWithoutEnv } = configuredProfile.settings;

function requirePatch(result: ReturnType<typeof buildCloudWorkerUpsertPatch>) {
  if ("error" in result) {
    throw new Error(`Unexpected profile patch error: ${result.error}`);
  }
  return result;
}

function profileConfig(profile: Record<string, unknown> = configuredProfile) {
  return { cloudWorkers: { profiles: { production: profile } } };
}

function addDraft(overrides: Partial<CloudWorkerProfileDraft> = {}) {
  return {
    ...createCloudWorkerDraft(),
    id: "new-profile",
    backend: "hetzner",
    machineClass: "standard",
    ...overrides,
  };
}

function editDraft(config = profileConfig(), overrides: Partial<CloudWorkerProfileDraft> = {}) {
  return { ...createCloudWorkerDraft(readCloudWorkerProfiles(config)[0]), ...overrides };
}

it.each([
  ["machineClass", { machineClass: "" }],
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
  if (expected === "machineClass") {
    expect(createCloudWorkerDraft().machineClass).toBe("");
  }
  const draft = addDraft(patch);
  expect(validateCloudWorkerDraft(draft, { production: configuredProfile }, null)).toBe(expected);
});

it.each(["setup", "advanced"] as const)(
  "clears %s with exact array intent while preserving other fields",
  (kind) => {
    const setup = kind === "setup";
    const initial = setup
      ? configuredProfile
      : {
          ...configuredProfile,
          readyWorkers: 2,
          settings: { ...configuredProfile.settings, warmImage: false },
        };
    const config = profileConfig(initial);
    const draft = editDraft(
      config,
      setup
        ? {
            backend: "hetzner",
            machineClass: "large",
            ttl: "8h",
            idleTimeout: "45m",
            setup: "",
            setupEnv: "",
            desktop: false,
            binary: "",
          }
        : { readyWorkers: "", suspendAfter: "", warmImage: "auto", setupEnv: "" },
    );
    const expected = setup
      ? {
          ...configuredProfile,
          settings: {
            ...baseSettings,
            provider: "hetzner",
            class: "large",
            ttl: "8h",
            idleTimeout: "45m",
          },
        }
      : {
          provider: "crabbox",
          install: "npm",
          suspendAfter: undefined,
          settings: settingsWithoutEnv,
        };
    const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
    expect(built.replacePaths).toEqual(["cloudWorkers.profiles.production.settings.setupEnv"]);
    const merged = applyMergePatch(config, built.patch);
    expect(merged).toEqual(profileConfig(expected));
    if (!setup) {
      for (const path of [
        "readyWorkers",
        "suspendAfter",
        "settings.warmImage",
        "settings.setupEnv",
      ]) {
        expect(merged).not.toHaveProperty(`cloudWorkers.profiles.production.${path}`);
      }
    }
  },
);
it("omits empty setup environment", () => {
  const profile = { ...configuredProfile, settings: settingsWithoutEnv };
  const config = profileConfig(profile);
  const draft = editDraft(config, { setup: "" });
  const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
  const { setup: _removedSetup, ...retainedSettings } = settingsWithoutEnv;
  expect(applyMergePatch(config, built.patch)).toEqual(
    profileConfig({ ...profile, settings: retainedSettings }),
  );
  expect(built.replacePaths).toEqual([]);
});

it("rejects an edit after its authoritative profile removes its class", () => {
  const config = profileConfig({
    provider: "crabbox",
    settings: { provider: "hetzner", ttl: "8h", idleTimeout: "45m", warmImage: false },
  });
  const draft = addDraft({ id: "production", backend: "aws", target: "linux" });
  expect(buildCloudWorkerUpsertPatch(config, draft, "production")).toEqual({
    error: "profileMissing",
  });
});

it.each(["1m1us", "59s"])("matches the suspendAfter schema for %s", (suspendAfter) => {
  const draft = addDraft({ id: "test", backend: "aws", suspendAfter });
  expect(
    CloudWorkersConfigSchema.safeParse({
      profiles: { test: { provider: "crabbox", suspendAfter } },
    }).success,
  ).toBe(false);
  expect(validateCloudWorkerDraft(draft, {}, null)).toBe("suspendAfter");
});

it("patches warm images as on and replaces setup names", () => {
  const config = profileConfig({
    ...configuredProfile,
    readyWorkers: 3,
    settings: { ...configuredProfile.settings, warmImage: true },
  });
  const draft = editDraft(config, {
    warmImage: "on",
    setupEnv: "BUILD_FLAG, CACHE_MODE\nEXTRA",
    readyWorkers: "0",
    suspendAfter: "2h",
  });
  const built = requirePatch(buildCloudWorkerUpsertPatch(config, draft, "production"));
  const merged = applyMergePatch(config, built.patch);
  expect(merged).toMatchObject(
    profileConfig({
      readyWorkers: 0,
      suspendAfter: "2h",
      settings: { setupEnv: ["BUILD_FLAG", "CACHE_MODE", "EXTRA"], warmImage: true },
    }),
  );
  expect(built.replacePaths).toEqual(["cloudWorkers.profiles.production.settings.setupEnv"]);
});

it("validates warm images after changing an existing profile target to windows/wsl2", () => {
  const config = profileConfig();
  for (const warmImage of ["auto", "on", "off"] as const) {
    const draft = editDraft(config, { target: "windows/wsl2", warmImage });
    const built = buildCloudWorkerUpsertPatch(config, draft, "production");
    if (warmImage === "on") {
      expect(built).toEqual({ error: "warmImage" });
    } else {
      expect(requirePatch(built).patch).toHaveProperty(
        "cloudWorkers.profiles.production.settings.warmImage",
        warmImage === "auto" ? null : false,
      );
    }
  }
});

it("accepts sixteen setup names without dropping or reordering them", () => {
  const names = Array.from({ length: 16 }, (_, index) => `BUILD_${index}`);
  const draft = addDraft({
    id: "build",
    backend: "aws",
    setup: "true",
    setupEnv: names.join(" , "),
  });
  const built = requirePatch(buildCloudWorkerUpsertPatch({}, draft, null));
  expect(built.patch).toHaveProperty("cloudWorkers.profiles.build.settings.setupEnv", names);
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
