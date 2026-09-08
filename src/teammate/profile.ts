/**
 * Teammate install profile: one persistent worker computer shared by named Bots.
 *
 * Opt-in only via `openclaw init --mode teammate`. Existing gateway-as-computer
 * installs are not rewritten.
 */
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStateDir } from "../config/paths.js";

/** One-sentence SLA written into the generated README and used in docs. */
export const TEAMMATE_SLA =
  "Closing Control UI does not stop a turn or a routine; the worker disk is the computer.";

export const TEAMMATE_INSTALL_PROFILE = "teammate" as const;

export const TEAMMATE_BACKENDS = ["docker", "openshell", "firecracker"] as const;
export type TeammateBackend = (typeof TEAMMATE_BACKENDS)[number];

export const DEFAULT_TEAMMATE_BACKEND: TeammateBackend = "docker";
export const DEFAULT_FIRECRACKER_OCI_RUNTIME = "io.containerd.kata.v2";
export const TEAMMATE_CONTAINER_HOME = "/home/bot";
export const TEAMMATE_CONTAINER_BROWSER = "/home/bot/.browser";

export function isTeammateBackend(value: string): value is TeammateBackend {
  return (TEAMMATE_BACKENDS as readonly string[]).includes(value);
}

export function isTeammateInstall(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.meta?.installProfile === TEAMMATE_INSTALL_PROFILE;
}

export type TeammateProfileOptions = {
  backend?: TeammateBackend;
  /** Host directory mounted at /home/bot inside the worker. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type TeammateProfilePaths = {
  homeDir: string;
  browserDir: string;
  containerHome: string;
  containerBrowser: string;
};

export function resolveTeammatePaths(
  options: TeammateProfileOptions = {},
): TeammateProfilePaths {
  const homeDir = options.homeDir?.trim()
    ? path.resolve(options.homeDir.trim())
    : path.join(resolveStateDir(options.env), "teammate", "home");
  return {
    homeDir,
    browserDir: path.join(homeDir, ".browser"),
    containerHome: TEAMMATE_CONTAINER_HOME,
    containerBrowser: TEAMMATE_CONTAINER_BROWSER,
  };
}

function resolveSandboxBackend(backend: TeammateBackend): string {
  return backend;
}

/** Overlay teammate defaults onto an existing config without touching unrelated keys. */
export function applyTeammateProfile(
  baseConfig: OpenClawConfig,
  options: TeammateProfileOptions = {},
): OpenClawConfig {
  const backend = options.backend ?? DEFAULT_TEAMMATE_BACKEND;
  const paths = resolveTeammatePaths(options);
  const homeBind = `${paths.homeDir}:${paths.containerHome}:rw`;
  const dockerRuntime =
    backend === "firecracker" ? DEFAULT_FIRECRACKER_OCI_RUNTIME : undefined;

  return {
    ...baseConfig,
    meta: {
      ...baseConfig.meta,
      installProfile: TEAMMATE_INSTALL_PROFILE,
    },
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        sandbox: {
          ...baseConfig.agents?.defaults?.sandbox,
          mode: "all",
          backend: resolveSandboxBackend(backend),
          scope: "shared",
          workspaceAccess: "rw",
          workspaceRoot: TEAMMATE_CONTAINER_HOME,
          docker: {
            ...baseConfig.agents?.defaults?.sandbox?.docker,
            workdir: TEAMMATE_CONTAINER_HOME,
            binds: uniqueBinds([
              ...(baseConfig.agents?.defaults?.sandbox?.docker?.binds ?? []),
              homeBind,
            ]),
            ...(dockerRuntime ? { runtime: dockerRuntime } : {}),
          },
          browser: {
            ...baseConfig.agents?.defaults?.sandbox?.browser,
            enabled: true,
            noVncEnabled: true,
            allowHostControl: true,
          },
          prune: {
            idleHours: baseConfig.agents?.defaults?.sandbox?.prune?.idleHours ?? 1,
            maxAgeDays: baseConfig.agents?.defaults?.sandbox?.prune?.maxAgeDays ?? 7,
          },
        },
        heartbeat: {
          every: "30m",
          ...baseConfig.agents?.defaults?.heartbeat,
        },
      },
    },
    tools: {
      ...baseConfig.tools,
      exec: {
        ...baseConfig.tools?.exec,
        host: "sandbox",
      },
      elevated: {
        ...baseConfig.tools?.elevated,
        enabled: false,
      },
    },
    browser: {
      ...baseConfig.browser,
      defaultProfile: baseConfig.browser?.defaultProfile ?? "teammate",
      profiles: {
        ...baseConfig.browser?.profiles,
        teammate: {
          ...baseConfig.browser?.profiles?.teammate,
          driver: "existing-session",
          userDataDir: paths.browserDir,
        },
      },
    },
    plugins:
      backend === "openshell"
        ? {
            ...baseConfig.plugins,
            entries: {
              ...baseConfig.plugins?.entries,
              openshell: {
                ...baseConfig.plugins?.entries?.openshell,
                enabled: true,
              },
            },
          }
        : baseConfig.plugins,
  };
}

function uniqueBinds(binds: string[]): string[] {
  return [...new Set(binds.filter((bind) => bind.trim()))];
}
