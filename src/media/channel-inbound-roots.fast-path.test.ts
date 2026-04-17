import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(),
}));
const bootstrapRegistryMocks = vi.hoisted(() => ({
  getBootstrapChannelPlugin: vi.fn(),
}));

vi.mock("../plugins/public-surface-loader.js", () => publicSurfaceLoaderMocks);
vi.mock("../channels/plugins/bootstrap-registry.js", () => bootstrapRegistryMocks);

import {
  resolveChannelInboundAttachmentRoots,
  resolveChannelRemoteInboundAttachmentRoots,
} from "./channel-inbound-roots.js";

const cfg = {
  channels: {},
} as OpenClawConfig;

function unableToResolve(dirName: string, artifactBasename: string): Error {
  return new Error(
    `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
  );
}

function createContext(provider: string, accountId = "work"): MsgContext {
  return {
    Body: "hi",
    From: "imessage:work:demo",
    To: "+2000",
    ChatType: "direct",
    Provider: provider,
    AccountId: accountId,
  };
}

beforeEach(() => {
  publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockReset();
  bootstrapRegistryMocks.getBootstrapChannelPlugin.mockReset();
});

describe("channel inbound roots fast path", () => {
  it("prefers media contract artifacts over full channel bootstrap", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        if (dirName === "imessage" && artifactBasename === "media-contract-api.js") {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/local/${accountId}`,
            ],
            resolveRemoteInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/remote/${accountId}`,
            ],
          };
        }
        throw unableToResolve(dirName, artifactBasename);
      },
    );

    expect(
      resolveChannelInboundAttachmentRoots({
        cfg,
        ctx: createContext("imessage"),
      }),
    ).toEqual(["/local/work"]);
    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("imessage"),
      }),
    ).toEqual(["/remote/work"]);
    expect(bootstrapRegistryMocks.getBootstrapChannelPlugin).not.toHaveBeenCalled();
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "imessage",
        artifactBasename: "media-contract-api.js",
      },
    );
  });

  it("falls back to generic contract artifacts before full channel bootstrap", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        if (dirName === "legacy-channel" && artifactBasename === "contract-api.js") {
          return {
            resolveRemoteInboundAttachmentRoots: () => ["/legacy-remote"],
          };
        }
        throw unableToResolve(dirName, artifactBasename);
      },
    );

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("legacy-channel"),
      }),
    ).toEqual(["/legacy-remote"]);
    expect(bootstrapRegistryMocks.getBootstrapChannelPlugin).not.toHaveBeenCalled();
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "legacy-channel",
        artifactBasename: "media-contract-api.js",
      },
    );
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "legacy-channel",
        artifactBasename: "contract-api.js",
      },
    );
  });

  it("uses channel bootstrap when no public root contract exists", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        throw unableToResolve(dirName, artifactBasename);
      },
    );
    bootstrapRegistryMocks.getBootstrapChannelPlugin.mockReturnValue({
      messaging: {
        resolveRemoteInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
          `/bootstrap/${accountId}`,
        ],
      },
    });

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("bootstrap-channel"),
      }),
    ).toEqual(["/bootstrap/work"]);
    expect(bootstrapRegistryMocks.getBootstrapChannelPlugin).toHaveBeenCalledWith(
      "bootstrap-channel",
    );
  });
});
