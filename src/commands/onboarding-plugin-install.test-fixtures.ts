import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  OnboardingPluginInstallEntry,
  OnboardingPluginInstallResult,
} from "./onboarding-plugin-install.types.js";

export function installedPlugin<T extends object>(fields: T) {
  return {
    ok: true,
    pluginId: "demo-plugin",
    targetDir: "/tmp/demo-plugin",
    version: "1.2.3",
    ...fields,
  };
}

export function notInstalled(
  status: "failed" | "skipped" | "timed_out",
  fields: Partial<OnboardingPluginInstallResult> = {},
) {
  return { cfg: {}, installed: false, pluginId: "demo-plugin", status, ...fields };
}

export function installEntry(
  install: OnboardingPluginInstallEntry["install"],
  details: Partial<Omit<OnboardingPluginInstallEntry, "install">> = {},
): OnboardingPluginInstallEntry {
  return { pluginId: "demo-plugin", label: "Demo Plugin", install, ...details };
}

export function installPolicyConfig(): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: { source: "exec", command: process.execPath, args: ["-e", "process.exit(1)"] },
      },
    },
  };
}

export function clawHubRecord() {
  return {
    source: "clawhub",
    clawhubUrl: "https://clawhub.ai",
    clawhubPackage: "demo-plugin",
    clawhubFamily: "code-plugin",
    clawhubChannel: "official",
    version: "2026.5.2",
    integrity: "sha256-clawpack",
    resolvedAt: "2026-05-02T00:00:00.000Z",
    clawpackSha256: "a".repeat(64),
    clawpackSpecVersion: 1,
    clawpackManifestSha256: "b".repeat(64),
    clawpackSize: 4096,
  };
}

export async function localWorkspace(root: string) {
  const workspaceDir = path.join(root, "workspace");
  const pluginDir = path.join(workspaceDir, "plugins", "demo");
  await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  return { workspaceDir, realPluginDir: await fs.realpath(pluginDir) };
}

export async function bundledDirectory(root: string, pluginId: string) {
  const dir = path.join(root, "dist", "extensions", pluginId);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}
