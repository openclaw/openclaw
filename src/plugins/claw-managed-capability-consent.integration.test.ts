import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectClawPluginCapabilities } from "../claws/plugin-capability-probe.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { clawHubSecurityResponse } from "./clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "./clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { installManagedPlugin } from "./management-mutations.js";

const clawhub = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  security: vi.fn(),
  download: vi.fn(),
  officialCatalog: vi.fn(async () => ({ source: "hosted" as const, entries: [] })),
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: clawhub.detail,
  fetchClawHubPackageArtifact: clawhub.artifact,
  fetchClawHubPackageSecurity: clawhub.security,
}));
vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: clawhub.download,
}));
vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: clawhub.officialCatalog,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const createClawHubArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function createEnv(root: string) {
  const env = {
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
  return env;
}

function manifest(id: string, tools: string[]) {
  return { id, contracts: { tools }, configSchema: { type: "object" } };
}

async function expectUnpublished(env: NodeJS.ProcessEnv, id = "claw-audit") {
  await expect(
    fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readPersistedInstalledPluginIndexInstallRecordsAsync({ env }))?.[id]).toBeFalsy();
}

async function writeJson(root: string, file: string, value: unknown) {
  await fs.writeFile(path.join(root, file), JSON.stringify(value));
}

function packageManifest(extensions = ["./index.js"], name = "@example/claw-audit") {
  return { name, version: "1.0.0", openclaw: { extensions } };
}

async function readInstalled(env: NodeJS.ProcessEnv) {
  const dir = path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit");
  return {
    artifact: await fs.readFile(path.join(dir, "openclaw.plugin.json")),
    record: (await readPersistedInstalledPluginIndexInstallRecordsAsync({ env }))?.["claw-audit"],
  };
}

async function writePluginSource(root: string, tool: string): Promise<string> {
  const sourceDir = path.join(root, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await writeJson(sourceDir, "package.json", packageManifest(["./index.js"]));
  await writeJson(sourceDir, "openclaw.plugin.json", manifest("claw-audit", [tool]));
  await fs.writeFile(path.join(sourceDir, "index.js"), "export {};\n");
  return sourceDir;
}

type InstallOptions = Omit<
  Parameters<typeof installManagedPlugin>[0],
  "request" | "env" | "clawManaged"
> & { mode?: "update" };

async function localFixture() {
  const root = dirs.make("openclaw-claw-plugin-");
  const sourceDir = await writePluginSource(root, "audit.read");
  const env = await createEnv(root);
  const install = ({ mode, ...options }: InstallOptions = {}) =>
    installManagedPlugin({
      request: { source: "local", path: sourceDir, ...(mode ? { mode } : {}) },
      env,
      clawManaged: true,
      ...options,
    });
  return { root, sourceDir, env, install };
}

async function withLocalFixture(
  run: (fixture: Awaited<ReturnType<typeof localFixture>>) => Promise<void>,
) {
  const fixture = await localFixture();
  await withEnvAsync(fixture.env, () => run(fixture));
}

async function findStagedPluginArtifactDir(env: NodeJS.ProcessEnv): Promise<string> {
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  const stages = (await fs.readdir(extensionsDir)).filter((entry) =>
    entry.startsWith(".openclaw-install-stage-"),
  );
  expect(stages).toHaveLength(1);
  return path.join(extensionsDir, stages[0]!);
}

it("denies an official ClawHub plugin before artifact and record commit, then installs after review", async () => {
  const root = dirs.make("openclaw-official-claw-plugin-consent-");
  const archive = await createClawHubArchive({
    "package.json": JSON.stringify(packageManifest(undefined, "@openclaw/diffs")),
    "openclaw.plugin.json": JSON.stringify(manifest("diffs", ["audit.read"])),
    "index.js": "export {};\n",
  });
  clawhub.detail.mockResolvedValue({
    package: {
      name: "@openclaw/diffs",
      displayName: "Diffs",
      family: "code-plugin",
      channel: "official",
      isOfficial: true,
      runtimeId: "diffs",
      latestVersion: "1.0.0",
      createdAt: 0,
      updatedAt: 0,
    },
  });
  clawhub.artifact.mockResolvedValue({
    version: { version: "1.0.0", sha256hash: archive.integrity },
  });
  clawhub.download.mockResolvedValue({ ...archive, cleanup: async () => {} });
  clawhub.security.mockResolvedValue(clawHubSecurityResponse("@openclaw/diffs", "1.0.0"));
  const env = {
    ...(await createEnv(root)),
    OPENCLAW_CLAWHUB_URL: undefined,
    CLAWHUB_URL: undefined,
  };
  const request = {
    source: "clawhub" as const,
    packageName: "@openclaw/diffs",
    version: "1.0.0",
    expectedIntegrity: archive.integrity,
  };

  await withEnvAsync(env, async () => {
    const denied = vi.fn(async () => undefined);
    await expect(
      installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: denied }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ declared: expect.objectContaining({ tools: ["audit.read"] }) }),
    );
    await expectUnpublished(env, "diffs");

    const accepted = vi.fn(async (review: { reviewToken: string }) => ({
      reviewToken: review.reviewToken,
    }));
    await expect(
      installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: accepted }),
    ).resolves.toMatchObject({ plugin: { id: "diffs", installed: true } });
    expect(accepted).toHaveBeenCalledOnce();
    expect(
      (await readPersistedInstalledPluginIndexInstallRecordsAsync({ env }))?.diffs,
    ).toMatchObject({
      source: "clawhub",
      clawhubPackage: "@openclaw/diffs",
      integrity: archive.integrity,
    });
  });
});

it("rejects missing consent before publishing an artifact or install record", async () => {
  await withLocalFixture(async ({ env, install }) => {
    await expect(install()).rejects.toMatchObject({
      capabilityConsent: { pluginId: "claw-audit" },
    });

    await expectUnpublished(env);
  });
});

it("keeps the installed artifact and record unchanged when update consent is denied", async () => {
  await withLocalFixture(async ({ root, env, install }) => {
    const reviewed: string[][] = [];
    await install({
      onCapabilityConsent: async (review) => {
        reviewed.push(review.declared.tools);
        return { reviewToken: review.reviewToken };
      },
    });
    expect(reviewed).toEqual([["audit.read"]]);
    const original = await readInstalled(env);
    expect(original.record?.acceptedSurface?.tools).toEqual(["audit.read"]);

    await writePluginSource(root, "audit.write");
    await expect(
      install({
        mode: "update",
        onCapabilityConsent: async (review) => {
          reviewed.push(review.declared.tools);
          return undefined;
        },
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

    expect(reviewed).toEqual([["audit.read"], ["audit.write"]]);
    expect(await readInstalled(env)).toEqual(original);
  });
});

it("rejects a staged capability change during the Claw owner's final check", async () => {
  await withLocalFixture(async ({ env, install }) => {
    let stageChanged = false;
    await expect(
      install({
        onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        beforePersistentEffect: async () => {
          if (stageChanged) {
            return;
          }
          stageChanged = true;
          const stagedArtifactDir = await findStagedPluginArtifactDir(env);
          await writeJson(
            stagedArtifactDir,
            "openclaw.plugin.json",
            manifest("claw-audit", ["audit.read", "audit.write"]),
          );
        },
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

    expect(stageChanged).toBe(true);
    await expectUnpublished(env);
  });
});

it("rejects sibling-entry drift even when the merged capability token is unchanged", async () => {
  await withLocalFixture(async ({ sourceDir, env, install }) => {
    await writeJson(sourceDir, "package.json", packageManifest(["./index.js", "./child/child.js"]));
    for (const name of ["child", "other"]) {
      await fs.mkdir(path.join(sourceDir, name));
      await fs.writeFile(path.join(sourceDir, name, name + ".js"), "export {};\n");
      await writeJson(
        sourceDir,
        name + "/openclaw.plugin.json",
        manifest("claw-audit-" + name, ["audit.child"]),
      );
    }

    const expected = inspectClawPluginCapabilities(sourceDir, "claw-audit", env);
    let changed: ReturnType<typeof inspectClawPluginCapabilities> | undefined;
    const pending = install({
      onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
      onBeforePluginArtifactCommit: async (artifact) => {
        const current = inspectClawPluginCapabilities(
          artifact.stagedArtifactDir,
          artifact.pluginId,
          env,
        );
        if (
          stableStringify(current.grantsByPluginId) !== stableStringify(expected.grantsByPluginId)
        ) {
          throw new Error("effective capability grants changed after planning");
        }
      },
      beforePersistentEffect: async () => {
        if (changed) {
          return;
        }
        const stagedArtifactDir = await findStagedPluginArtifactDir(env);
        await writeJson(
          stagedArtifactDir,
          "package.json",
          packageManifest(["./index.js", "./other/other.js"]),
        );
        changed = inspectClawPluginCapabilities(stagedArtifactDir, "claw-audit", env);
      },
    });
    await expect(pending).rejects.toThrow("effective capability grants changed after planning");
    expect(changed?.declared).toEqual(expected.declared);
    expect(changed?.grantsByPluginId).not.toEqual(expected.grantsByPluginId);
    await expectUnpublished(env);
  });
});

it("rejects final-stage capability drift without replacing the installed plugin", async () => {
  await withLocalFixture(async ({ root, env, install }) => {
    const onCapabilityConsent = async (review: { reviewToken: string }) => ({
      reviewToken: review.reviewToken,
    });
    await install({ onCapabilityConsent });
    const original = await readInstalled(env);

    await writePluginSource(root, "audit.write");
    await expect(
      install({
        mode: "update",
        onCapabilityConsent,
        beforePersistentEffect: async () => {
          const stagedArtifactDir = await findStagedPluginArtifactDir(env);
          await writeJson(
            stagedArtifactDir,
            "openclaw.plugin.json",
            manifest("claw-audit", ["audit.write", "audit.admin"]),
          );
        },
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

    expect(await readInstalled(env)).toEqual(original);

    await install({ mode: "update", onCapabilityConsent });
    expect(
      (await readPersistedInstalledPluginIndexInstallRecordsAsync({ env }))?.["claw-audit"]
        ?.acceptedSurface?.tools,
    ).toEqual(["audit.write"]);
  });
});
