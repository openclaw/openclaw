import fs from "node:fs";
import path from "node:path";

import type { BrowserProfileConfig, ClawdisConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveClawdUserDataDir } from "./chrome.js";
import { parseHttpUrl, resolveProfile } from "./config.js";
import {
  allocateCdpPort,
  allocateColor,
  getUsedColors,
  getUsedPorts,
  isValidProfileName,
} from "./profiles.js";
import type { BrowserRouteContext, ProfileStatus } from "./server-context.js";
import { movePathToTrash } from "./trash.js";

export type CreateProfileParams = {
  name: string;
  color?: string;
  cdpUrl?: string;
};

export type CreateProfileResult = {
  ok: true;
  profile: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
  isRemote: boolean;
};

export type DeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function createBrowserProfilesService(ctx: BrowserRouteContext) {
  const listProfiles = async (): Promise<ProfileStatus[]> => {
    return await ctx.listProfiles();
  };

  const createProfile = async (
    params: CreateProfileParams,
  ): Promise<CreateProfileResult> => {
    const name = params.name.trim();
    const rawCdpUrl = params.cdpUrl?.trim() || undefined;

    if (!isValidProfileName(name)) {
      throw new Error(
        "invalid profile name: use lowercase letters, numbers, and hyphens only",
      );
    }

    const state = ctx.state();
    const resolvedProfiles = state.resolved.profiles;
    if (name in resolvedProfiles) {
      throw new Error(`profile "${name}" already exists`);
    }

    const cfg = loadConfig();
    const rawProfiles = cfg.browser?.profiles ?? {};
    if (name in rawProfiles) {
      throw new Error(`profile "${name}" already exists`);
    }

    const usedColors = getUsedColors(resolvedProfiles);
    const profileColor =
      params.color && HEX_COLOR_RE.test(params.color)
        ? params.color
        : allocateColor(usedColors);

    let profileConfig: BrowserProfileConfig;
    if (rawCdpUrl) {
      const parsed = parseHttpUrl(rawCdpUrl, "browser.profiles.cdpUrl");
      profileConfig = { cdpUrl: parsed.normalized, color: profileColor };
    } else {
      const usedPorts = getUsedPorts(resolvedProfiles);
      const cdpPort = allocateCdpPort(usedPorts);
      if (cdpPort === null) {
        throw new Error("no available CDP ports in range");
      }
      profileConfig = { cdpPort, color: profileColor };
    }

    const nextConfig: ClawdisConfig = {
      ...cfg,
      browser: {
        ...cfg.browser,
        profiles: {
          ...rawProfiles,
          [name]: profileConfig,
        },
      },
    };

    await writeConfigFile(nextConfig);

    state.resolved.profiles[name] = profileConfig;
    const resolved = resolveProfile(state.resolved, name);
    if (!resolved) {
      throw new Error(`profile "${name}" not found after creation`);
    }

    return {
      ok: true,
      profile: name,
      cdpPort: resolved.cdpPort,
      cdpUrl: resolved.cdpUrl,
      color: resolved.color,
      isRemote: !resolved.cdpIsLoopback,
    };
  };

  const deleteProfile = async (
    nameRaw: string,
  ): Promise<DeleteProfileResult> => {
    const name = nameRaw.trim();
    if (!name) throw new Error("profile name is required");
    if (!isValidProfileName(name)) {
      throw new Error("invalid profile name");
    }

    const cfg = loadConfig();
    const profiles = cfg.browser?.profiles ?? {};
    if (!(name in profiles)) {
      throw new Error(`profile "${name}" not found`);
    }

    const defaultProfile = cfg.browser?.defaultProfile ?? "clawd";
    if (name === defaultProfile) {
      throw new Error(
        `cannot delete the default profile "${name}"; change browser.defaultProfile first`,
      );
    }

    let deleted = false;
    const state = ctx.state();
    const resolved = resolveProfile(state.resolved, name);

    if (resolved?.cdpIsLoopback) {
      try {
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }

      const userDataDir = resolveClawdUserDataDir(name);
      const profileDir = path.dirname(userDataDir);
      if (fs.existsSync(profileDir)) {
        await movePathToTrash(profileDir);
        deleted = true;
      }
    }

    const { [name]: _removed, ...remainingProfiles } = profiles;
    const nextConfig: ClawdisConfig = {
      ...cfg,
      browser: {
        ...cfg.browser,
        profiles: remainingProfiles,
      },
    };

    await writeConfigFile(nextConfig);

    delete state.resolved.profiles[name];
    state.profiles.delete(name);

    return { ok: true, profile: name, deleted };
  };

  return {
    listProfiles,
    createProfile,
    deleteProfile,
  };
}
