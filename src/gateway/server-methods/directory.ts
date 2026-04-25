import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function parseDirectoryLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return null;
    }
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function resolveDirectoryChannel(
  params: Record<string, unknown>,
):
  | { ok: true; channelId: ChannelId; plugin: ChannelPlugin }
  | { ok: false; error: ReturnType<typeof errorShape> } {
  const channelRaw = readStringValue(params.channel);
  if (!channelRaw?.trim()) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "directory: missing channel"),
    };
  }
  const channelId = normalizeChannelId(channelRaw);
  if (!channelId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `directory: invalid channel: ${channelRaw}`),
    };
  }
  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `directory: unknown channel: ${channelId}`),
    };
  }
  return { ok: true, channelId, plugin };
}

function resolveDirectoryAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  requestParams: Record<string, unknown>;
}): string {
  const fromParams =
    normalizeOptionalString(params.requestParams.accountId) ??
    normalizeOptionalString(params.requestParams.account);
  return fromParams || resolveChannelDefaultAccountId({ plugin: params.plugin, cfg: params.cfg });
}

async function loadAutoEnabledConfig() {
  const { config } = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  });
  return config;
}

export const directoryHandlers: GatewayRequestHandlers = {
  "directory.self": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveDirectoryChannel(p);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const cfg = await loadAutoEnabledConfig();
      const { plugin, channelId } = resolved;
      const fn = plugin.directory?.self;
      if (!fn) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `channel ${channelId} does not support directory.self`,
          ),
        );
        return;
      }
      const accountId = resolveDirectoryAccountId({ plugin, cfg, requestParams: p });
      const result = await fn({ cfg, accountId, runtime: defaultRuntime });
      respond(true, result ?? null, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "directory.peers.list": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveDirectoryChannel(p);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const cfg = await loadAutoEnabledConfig();
      const { plugin, channelId } = resolved;
      const fn = plugin.directory?.listPeersLive ?? plugin.directory?.listPeers;
      if (!fn) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `channel ${channelId} does not support directory peers list`,
          ),
        );
        return;
      }
      const accountId = resolveDirectoryAccountId({ plugin, cfg, requestParams: p });
      const result = await fn({
        cfg,
        accountId,
        query: normalizeOptionalString(p.query) ?? null,
        limit: parseDirectoryLimit(p.limit),
        runtime: defaultRuntime,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "directory.groups.list": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveDirectoryChannel(p);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const cfg = await loadAutoEnabledConfig();
      const { plugin, channelId } = resolved;
      const fn = plugin.directory?.listGroupsLive ?? plugin.directory?.listGroups;
      if (!fn) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `channel ${channelId} does not support directory.groups.list`,
          ),
        );
        return;
      }
      const accountId = resolveDirectoryAccountId({ plugin, cfg, requestParams: p });
      const result = await fn({
        cfg,
        accountId,
        query: normalizeOptionalString(p.query) ?? null,
        limit: parseDirectoryLimit(p.limit),
        runtime: defaultRuntime,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
