import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import { collectChangedConfigPaths } from "../../config/include-write-boundary.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";

type ConfigValue = { path: readonly string[]; value: unknown };

/** Changes an account delete made outside `channels`, persisted after the delete itself. */
export type ChannelAccountDeleteFollowUp = {
  paths: readonly string[];
  /** What the delete left under `channels`; the follow-up applies only while that still holds. */
  deleted: readonly ConfigValue[];
  previous: readonly ConfigValue[];
  next: readonly ConfigValue[];
};

function setOrUnset(config: OpenClawConfig, path: readonly string[], value: unknown) {
  if (value === undefined) {
    unsetConfigValueAtPath(config, [...path]);
  } else {
    setConfigValueAtPath(config, path, structuredClone(value));
  }
}

/**
 * Keeps a delete adapter's `channels` changes in the caller's write and moves any other change
 * (such as bindings it drops) into a follow-up write. The config writer lets a single $include
 * file own each write, so one combined write fails when those sections live in different files.
 */
export function splitChannelAccountDelete(params: {
  cfg: OpenClawConfig;
  nextConfig: OpenClawConfig;
}): { config: OpenClawConfig; followUp?: ChannelAccountDeleteFollowUp } {
  const changed = collectChangedConfigPaths(params.cfg, params.nextConfig);
  const outside = changed.rootChanged
    ? []
    : changed.paths.filter((path) => path.length > 0 && path[0] !== "channels");
  if (outside.length === 0) {
    return { config: params.nextConfig };
  }
  const valuesAt = (config: OpenClawConfig, paths: readonly (readonly string[])[]) =>
    paths.map((path) => ({ path, value: getConfigValueAtPath(config, path) }));
  const previous = valuesAt(params.cfg, outside);
  const config = structuredClone(params.nextConfig);
  for (const { path, value } of previous) {
    setOrUnset(config, path, value);
  }
  return {
    config,
    followUp: {
      paths: outside.map((path) => path.join(".")),
      deleted: valuesAt(
        params.nextConfig,
        changed.paths.filter((path) => path[0] === "channels"),
      ),
      previous,
      next: valuesAt(params.nextConfig, outside),
    },
  };
}

/** Applies the follow-up's changes to an in-memory config, as the follow-up write persists them. */
export function applyChannelAccountDeleteFollowUp(
  config: OpenClawConfig,
  followUp: ChannelAccountDeleteFollowUp,
  snapshot?: Pick<ConfigFileSnapshot, "includeProvenance">,
): void {
  for (const [position, { path, value }] of followUp.next.entries()) {
    // An include authored exactly at this path owns it; the root file cannot drop the key.
    const included = snapshot?.includeProvenance?.some(
      (entry) =>
        entry.path.length === path.length &&
        entry.path.every((segment, index) => segment === path[index]),
    );
    const previous = followUp.previous[position]?.value;
    setOrUnset(
      config,
      path,
      value === undefined && included && Array.isArray(previous) ? [] : value,
    );
  }
}

/**
 * Deletes an account for a caller that commits later. With a sink, changes outside `channels` go
 * to the sink for their own write after that commit; without one they stay in the returned config.
 */
export function deleteChannelAccount(
  cfg: OpenClawConfig,
  plugin:
    | {
        config: {
          deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
        };
      }
    | undefined,
  accountId: string,
  sink?: { onAccountDeleteFollowUp?: (followUp: ChannelAccountDeleteFollowUp) => void },
): OpenClawConfig {
  if (!plugin?.config.deleteAccount) {
    return cfg;
  }
  const deleted = plugin.config.deleteAccount({ cfg, accountId });
  const removed = splitChannelAccountDelete({ cfg, nextConfig: deleted });
  if (!removed.followUp || !sink?.onAccountDeleteFollowUp) {
    return deleted;
  }
  sink.onAccountDeleteFollowUp(removed.followUp);
  return removed.config;
}
