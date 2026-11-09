import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as clawhubArtifacts from "../infra/clawhub-artifacts.js";
import * as clawhubPackages from "../infra/clawhub-packages.js";
import * as npmMetadata from "../infra/install-source-utils.js";
import * as bundledSources from "./bundled-sources.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash, resolveAcceptedSurfaceCurrent } from "./capability-summary.js";
import { clawHubSecurityResponse, clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  createClawHubArchiveFactory,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
} from "./clawhub.test-support.js";
import * as npmInstaller from "./install.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const createArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  "current",
  "rewrite npm",
  "stale consent",
  "missing consent",
  "reject consent",
  "missing manifest",
  "invalid manifest",
  "different artifact",
  "missing entry",
])("updates only actual effects, preserving repair and consent: %s", async (state) => {
  const manifest = {
    id: "demo",
    providers: ["fixture-provider"],
    configSchema: { type: "object" },
  };
  const entries = {
    ...DEMO_PLUGIN_ARCHIVE_ENTRIES,
    "openclaw.plugin.json": JSON.stringify(manifest),
  };
  const archive = await createArchive(entries);
  const root = path.dirname(archive.archivePath);
  const installPath = path.join(root, "demo");
  const otherPath = path.join(root, "other");
  await fs.mkdir(installPath);
  await fs.mkdir(otherPath);
  for (const [file, bytes] of Object.entries(entries)) {
    await fs.writeFile(path.join(installPath, file), bytes);
  }
  await fs.writeFile(
    path.join(otherPath, "package.json"),
    JSON.stringify({ name: "@acme/other", version: "1.2.3" }),
  );
  const config: OpenClawConfig = {
    plugins: {
      entries: { demo: { enabled: true } },
      installs: {
        demo: {
          source: "clawhub",
          spec: "clawhub:demo",
          clawhubUrl: "https://registry.example",
          clawhubPackage: "demo",
          clawhubFamily: "code-plugin",
          clawhubChannel: "community",
          version: "2026.3.22",
          installPath,
          integrity: archive.integrity,
        },
        other: {
          source: "npm",
          spec: "@acme/other",
          installPath: otherPath,
          resolvedName: "@acme/other",
          resolvedVersion: "1.2.3",
          resolvedSpec: "@acme/other@1.2.3",
          integrity: "sha512-same",
        },
      },
    },
  };
  const record = config.plugins!.installs!.demo!;
  const declared = resolvePluginArtifactDeclaredSurface(installPath, process.env, { config });
  Object.assign(record, {
    acceptedSurface: declared,
    acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
    acceptedSurfaceIntegrity: archive.integrity,
    acceptedSurfaceAt: "2026-11-01T00:00:00.000Z",
  });
  if (state === "stale consent" || state === "reject consent") {
    record.acceptedSurface = { ...declared, providers: [] };
    record.acceptedSurfaceHash = computeDeclaredSurfaceHash(record.acceptedSurface);
  } else if (state === "missing consent") {
    delete record.acceptedSurface;
  } else if (state === "missing manifest" || state === "missing entry") {
    await fs.unlink(
      path.join(installPath, state === "missing manifest" ? "openclaw.plugin.json" : "index.js"),
    );
  } else if (state === "invalid manifest") {
    await fs.writeFile(path.join(installPath, "openclaw.plugin.json"), "{");
  } else if (state === "different artifact") {
    record.integrity = "sha256-old";
  }
  vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(new Map());
  vi.spyOn(clawhubPackages, "fetchClawHubPackageDetail").mockResolvedValue({
    package: {
      name: "demo",
      displayName: "Demo",
      family: "code-plugin",
      channel: "community",
      isOfficial: false,
      createdAt: 0,
      updatedAt: 0,
      latestVersion: "2026.3.22",
    },
  });
  vi.spyOn(clawhubPackages, "fetchClawHubPackageArtifact").mockResolvedValue(
    clawHubVersionMetadata({
      sha256hash: Buffer.from(archive.integrity.slice(7), "base64").toString("hex"),
    }),
  );
  vi.spyOn(clawhubPackages, "fetchClawHubPackageSecurity").mockResolvedValue(
    clawHubSecurityResponse(),
  );
  const download = vi.spyOn(clawhubArtifacts, "downloadClawHubPackageArchive").mockResolvedValue({
    ...archive,
    artifact: "archive",
    sha256Hex: Buffer.from(archive.integrity.slice(7), "base64").toString("hex"),
    cleanup: async () => {},
  });
  const npmInstall = vi
    .spyOn(npmInstaller, "installPluginFromNpmSpec")
    .mockRejectedValue(new Error("npm installer should not run"));
  vi.spyOn(npmMetadata, "resolveNpmSpecMetadata").mockResolvedValue({
    ok: true,
    metadata: {
      name: "@acme/other",
      version: "1.2.3",
      resolvedSpec: "@acme/other@1.2.3",
      integrity: "sha512-same",
    },
  });
  const consent = vi.fn(async ({ reviewToken }: { reviewToken: string }) =>
    state === "reject consent" ? undefined : { reviewToken },
  );
  const result = await updateNpmInstalledPlugins({
    config,
    pluginIds: ["demo", "other"],
    onCapabilityConsent: consent,
    specOverrides: state === "rewrite npm" ? { other: "@acme/other@1.2.3" } : undefined,
  });
  const retained = state === "current" || state === "rewrite npm";
  expect(result.changed).toBe((!retained && state !== "reject consent") || state === "rewrite npm");
  expect(download).toHaveBeenCalledTimes(retained ? 0 : 1);
  expect(result.outcomes.map(({ status }) => status)).toEqual([
    state === "reject consent" ? "error" : "unchanged",
    "unchanged",
  ]);
  expect(npmInstall).not.toHaveBeenCalled();
  expect(result.config.plugins?.installs?.other?.spec).toBe(
    state === "rewrite npm" ? "@acme/other@1.2.3" : "@acme/other",
  );
  if (state.includes("consent")) {
    expect(consent).toHaveBeenCalledOnce();
  }
  if (retained) {
    expect(result.config.plugins?.installs?.demo).toEqual(record);
  } else if (state !== "reject consent") {
    const next = result.config.plugins!.installs!.demo!;
    const actual = resolvePluginArtifactDeclaredSurface(next.installPath!, process.env, {
      config: result.config,
    });
    expect(resolveAcceptedSurfaceCurrent(next, actual)).toBe(true);
    expect(
      JSON.parse(await fs.readFile(path.join(next.installPath!, "openclaw.plugin.json"), "utf8")),
    ).toEqual(manifest);
  }
});
