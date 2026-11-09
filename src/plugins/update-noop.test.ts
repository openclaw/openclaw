import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as npmMetadata from "../infra/install-source-utils.js";
import * as bundledSources from "./bundled-sources.js";
import * as clawhubInstaller from "./clawhub.js";
import * as npmInstaller from "./install.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "counts only actual changes with unchanged plugins (rewrite=%s)",
  async (rewrite) => {
    const root = tempDirs.make("openclaw-update-noop-");
    const paths = Object.fromEntries(
      ["discord", "demo"].map((id) => {
        const dir = path.join(root, id);
        fs.mkdirSync(dir);
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: id === "discord" ? "@openclaw/discord" : "@acme/demo",
            version: "2027.2.1",
          }),
        );
        return [id, dir];
      }),
    );
    const clawhub = {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "@openclaw/discord",
      clawhubFamily: "code-plugin" as const,
      clawhubChannel: "official" as const,
      version: "2027.2.1",
      integrity: "sha256-same",
    };
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(new Map());
    vi.spyOn(clawhubInstaller, "installPluginFromClawHub").mockResolvedValue({
      ok: true,
      unchanged: true,
      pluginId: "discord",
      targetDir: paths.discord!,
      version: "2027.2.1",
      extensions: ["index.js"],
      packageName: "@openclaw/discord",
      clawhub,
    });
    const npmInstall = vi
      .spyOn(npmInstaller, "installPluginFromNpmSpec")
      .mockRejectedValue(new Error("installer should not run"));
    vi.spyOn(npmMetadata, "resolveNpmSpecMetadata").mockResolvedValue({
      ok: true,
      metadata: {
        name: "@acme/demo",
        version: "2027.2.1",
        resolvedSpec: "@acme/demo@2027.2.1",
        integrity: "sha512-same",
      },
    });
    const config: OpenClawConfig = {
      plugins: {
        installs: {
          discord: { ...clawhub, spec: "clawhub:@openclaw/discord", installPath: paths.discord },
          demo: {
            source: "npm",
            spec: "@acme/demo",
            installPath: paths.demo,
            resolvedName: "@acme/demo",
            resolvedVersion: "2027.2.1",
            resolvedSpec: "@acme/demo@2027.2.1",
            integrity: "sha512-same",
          },
        },
      },
    };
    const result = await updateNpmInstalledPlugins({
      config,
      pluginIds: ["discord", "demo"],
      specOverrides: rewrite ? { demo: "@acme/demo@2027.2.1" } : undefined,
    });
    expect(result.outcomes.map(({ status }) => status)).toEqual(["unchanged", "unchanged"]);
    expect(result.changed).toBe(rewrite);
    expect(result.config.plugins?.installs?.demo?.spec).toBe(
      rewrite ? "@acme/demo@2027.2.1" : "@acme/demo",
    );
    expect(result.config.plugins?.installs?.discord).toEqual(config.plugins?.installs?.discord);
    expect(npmInstall).not.toHaveBeenCalled();
  },
);
