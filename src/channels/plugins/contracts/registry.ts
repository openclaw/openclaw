import { listBundledChannelPlugins } from "../bundled.js";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { listBundledChannelPlugins, setBundledChannelRuntime } from "../bundled.js";
import type { ChannelPlugin } from "../types.js";
import {
  channelPluginSurfaceKeys,
  type ChannelPluginSurface,
} from "./manifest.js";

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
  expectedSurfaces: ChannelPluginSurface[];
};

type ThreadingContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "threading">;
};

type DirectoryContractEntry = {
  id: string;
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage?: "lookups" | "presence";
};

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (to: string, _message: string, opts?: { threadId?: string }) => ({
    messageId: opts?.threadId ? "$matrix-thread" : "$matrix-root",
    roomId: to.replace(/^room:/, ""),
  })),
);

const lineContractApi = await import(buildBundledPluginModuleId("line", "contract-api.js"));

setBundledChannelRuntime("line", {
  channel: {
    line: {
      listLineAccountIds: lineContractApi.listLineAccountIds,
      resolveDefaultLineAccountId: lineContractApi.resolveDefaultLineAccountId,
      resolveLineAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
        lineContractApi.resolveLineAccount({ cfg, accountId }),
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

const directoryPresenceOnlyIds = new Set<string>(["whatsapp", "zalouser"]);

function resolveSurfacesFromPlugin(plugin: ChannelPlugin): ChannelPluginSurface[] {
  const surfaces: ChannelPluginSurface[] = [];
  for (const surface of channelPluginSurfaceKeys) {
    if (plugin[surface] !== undefined) {
      surfaces.push(surface);
    }
  }
  return surfaces;
}

export function getSurfaceContractRegistry(): SurfaceContractEntry[] {
  surfaceContractRegistryCache ??= listBundledChannelPlugins().map((plugin) => ({
    id: plugin.id,
    plugin,
    expectedSurfaces: resolveSurfacesFromPlugin(plugin),
  }));
  return surfaceContractRegistryCache;
}

export function getThreadingContractRegistry(): ThreadingContractEntry[] {
  threadingContractRegistryCache ??= listBundledChannelPlugins()
    .filter((plugin) => Boolean(plugin.threading))
    .map((plugin) => ({ id: plugin.id, plugin }));
  return threadingContractRegistryCache;
}

export function getDirectoryContractRegistry(): DirectoryContractEntry[] {
  directoryContractRegistryCache ??= listBundledChannelPlugins()
    .filter((plugin) => Boolean(plugin.directory))
    .map((plugin) => ({
      id: plugin.id,
      plugin,
      coverage: directoryPresenceOnlyIds.has(plugin.id) ? "presence" : "lookups",
    }));
  return directoryContractRegistryCache;
}
