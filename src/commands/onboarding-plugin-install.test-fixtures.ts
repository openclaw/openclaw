import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureOnboardingPluginInstalled } from "./onboarding-plugin-install.js";
import type {
  OnboardingPluginInstallEntry,
  OnboardingPluginInstallOptions,
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

export function requireCapturedPrompt<T>(captured: T | undefined): T {
  if (!captured) {
    throw new Error("expected captured install prompt");
  }
  return captured;
}

export function firstCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T {
  return requireCapturedPrompt(mock.mock.calls[0]);
}

export type InstallChoice = "clawhub" | "npm" | "local" | "skip";
export type InstallPrompt = Parameters<OnboardingPluginInstallOptions["prompter"]["select"]>[0];
export type NpmPackInstallCall = Parameters<
  typeof import("../plugins/install.js").installPluginFromNpmPackArchive
>[0];
export type NpmSpecInstallCall = Parameters<
  typeof import("../plugins/install.js").installPluginFromNpmSpec
>[0];
export type ClawHubInstallCall = Parameters<
  typeof import("../plugins/clawhub.js").installPluginFromClawHub
>[0];

export const skipOption = { value: "skip", label: "Skip for now" };
export function localOption(hint: string) {
  return { value: "local", label: "Use local plugin path", hint };
}

/** Runs onboarding install with an empty config and runtime unless overridden. */
export function runInstall(
  entry: OnboardingPluginInstallOptions["entry"],
  prompter: OnboardingPluginInstallOptions["prompter"],
  options: Partial<Omit<OnboardingPluginInstallOptions, "entry" | "prompter">> = {},
) {
  return ensureOnboardingPluginInstalled({
    cfg: {},
    runtime: {} as never,
    ...options,
    entry,
    prompter,
  });
}
