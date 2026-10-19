import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OnboardingPluginInstallEntry } from "./onboarding-plugin-install.types.js";

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
