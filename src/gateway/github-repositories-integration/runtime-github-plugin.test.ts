import { describe, expect, it } from "vitest";
import {
  asConfig,
  setupSecretsRuntimeSnapshotTestHooks,
} from "../../secrets/runtime.test-support.js";
import { readGitHubConfig } from "../github-repository-fixture-api.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const app = {
  appId: 101,
  installationId: 202,
  accountId: 303,
  repositories: [{ id: 404, fullName: "example/project" }],
  permissions: { contents: "read" },
  keyVersion: "fixture-generation",
};
const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
const owner = "plugins.entries.github-repositories.config.service.token";
const pluginOrigins = new Map([["github-repositories", "bundled" as const]]);

describe("GitHub plugin secret ownership", () => {
  it("materializes canonical service and App secrets without changing authored refs", async () => {
    const authored = asConfig({
      plugins: {
        entries: {
          "github-repositories": {
            config: {
              service: { token: ref("FIXTURE_GITHUB_SERVICE") },
              system: {
                profileId: "ghp_" + "a".repeat(32),
                kind: "app-installation",
                app: { ...app, privateKey: ref("FIXTURE_GITHUB_KEY") },
              },
            },
          },
        },
      },
    });
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: authored,
      env: {
        FIXTURE_GITHUB_SERVICE: "synthetic-service",
        FIXTURE_GITHUB_KEY: "synthetic-signing-material",
      },
      loadablePluginOrigins: pluginOrigins,
      includeAuthStoreRefs: false,
    });
    expect(readGitHubConfig(authored).service?.token).toEqual(ref("FIXTURE_GITHUB_SERVICE"));
    expect(readGitHubConfig(snapshot.config).service?.token).toBe("synthetic-service");
    const identity = readGitHubConfig(snapshot.config).system;
    expect(identity?.kind === "app-installation" && identity.app.privateKey).toBe(
      "synthetic-signing-material",
    );
  });

  it("leaves missing canonical refs dormant when the entire plugin is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            "github-repositories": {
              enabled: false,
              config: {
                service: { token: ref("MISSING_GITHUB_SERVICE") },
                agents: {
                  build: {
                    profileId: "ghp_" + "b".repeat(32),
                    kind: "app-installation",
                    app: { ...app, privateKey: ref("MISSING_GITHUB_KEY") },
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      loadablePluginOrigins: pluginOrigins,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    expect(readGitHubConfig(snapshot.config).service?.token).toEqual(ref("MISSING_GITHUB_SERVICE"));
    expect(snapshot.degradedOwners).toEqual([]);
    expect(snapshot.warnings.map(({ path }) => path)).toContain(owner);
  });

  it("isolates an unavailable canonical service owner instead of selecting another token", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                service: { token: ref("MISSING_GITHUB_SERVICE") },
              },
            },
          },
        },
      }),
      env: { GH_TOKEN: "independent-native-credential" },
      loadablePluginOrigins: pluginOrigins,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    expect(snapshot.degradedOwners).toMatchObject([{ ownerKind: "capability", ownerId: owner }]);
    expect(readGitHubConfig(snapshot.config).service?.token).not.toBe(
      "independent-native-credential",
    );
  });
});
