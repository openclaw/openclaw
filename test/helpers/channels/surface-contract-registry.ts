import { vi } from "vitest";
import {
  listBundledChannelPlugins,
  setBundledChannelRuntime,
} from "../../../src/channels/plugins/bundled.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/plugin-sdk/line.js";
import { channelPluginSurfaceKeys, type ChannelPluginSurface } from "./manifest.js";

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "..", "extensions", pluginId, artifactBasename].join("/");
}

type SurfaceContractEntry = {
  id: string;
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surfaces: readonly ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
};

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$matrix-thread" : "$matrix-root",
    roomId: to.replace(/^room:/, ""),
  })),
);

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        resolveLineAccount({ cfg, accountId }),
    },
  },
} as never);

vi.mock(buildBundledPluginModuleId("matrix", "runtime-api.js"), async () => {
  const matrixRuntimeApiModuleId = buildBundledPluginModuleId("matrix", "runtime-api.js");
  const actual = await vi.importActual(matrixRuntimeApiModuleId);
  return {
    ...actual,
    sendMessageMatrix: sendMessageMatrixMock,
  };
});

let surfaceContractRegistryCache: SurfaceContractEntry[] | undefined;
let threadingContractRegistryCache: ThreadingContractEntry[] | undefined;
let directoryContractRegistryCache: DirectoryContractEntry[] | undefined;

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
    surfaces: channelPluginSurfaceKeys.filter((surface) => Boolean(plugin[surface])),
  }));
  return surfaceContractRegistryCache;
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("threading"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
    }));
  return threadingContractRegistryCache;
}

const directoryPresenceOnlyIds = new Set(["whatsapp", "zalouser"]);

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= getSurfaceContractRegistry()
    .filter((entry) => entry.surfaces.includes("directory"))
    .map((entry) => ({
      id: entry.id,
      plugin: entry.plugin,
      coverage: directoryPresenceOnlyIds.has(entry.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}
