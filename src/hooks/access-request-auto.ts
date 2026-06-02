import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";

export const ACCESS_REQUEST_HOOK_NAME = "access-request";

function hasAllowlistDmPolicy(value: unknown): boolean {
  return isPlainObject(value) && value.dmPolicy === "allowlist";
}

function channelHasAllowlistDmPolicy(channelConfig: unknown): boolean {
  if (!isPlainObject(channelConfig)) {
    return false;
  }
  if (hasAllowlistDmPolicy(channelConfig)) {
    return true;
  }
  const accounts = channelConfig.accounts;
  if (!isPlainObject(accounts)) {
    return false;
  }
  return Object.values(accounts).some(hasAllowlistDmPolicy);
}

export function hasAnyAllowlistDmPolicy(config: OpenClawConfig | undefined): boolean {
  const channels = config?.channels;
  if (!isPlainObject(channels)) {
    return false;
  }
  return Object.values(channels).some(channelHasAllowlistDmPolicy);
}

export function shouldAutoEnableAccessRequestHook(config: OpenClawConfig | undefined): boolean {
  if (config?.hooks?.internal?.enabled === false) {
    return false;
  }
  if (config?.hooks?.internal?.entries?.[ACCESS_REQUEST_HOOK_NAME]?.enabled === false) {
    return false;
  }
  return hasAnyAllowlistDmPolicy(config);
}
