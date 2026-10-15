// Channel inbound root fast-path tests cover cached media root resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: vi.fn(),
  loadPluginPublicArtifactModuleSync: vi.fn(),
}));

vi.mock("../plugins/public-surface-loader.js", () => publicSurfaceLoaderMocks);

// Installed-plugin discovery is out of scope for the bundled fast path; keep these
// tests independent of the host plugin metadata graph.
vi.mock("../plugins/plugin-metadata-snapshot.runtime.js", () => ({
  getCurrentPluginMetadataSnapshotRuntime: () => undefined,
  resolvePluginMetadataSnapshotRuntime: () => undefined,
}));

import {
  resolveChannelInboundAttachmentRoots,
  resolveChannelInboundAttachmentRootsForChannel,
  resolveChannelRemoteInboundAttachmentRoots,
} from "./channel-inbound-roots.js";

const cfg = {
  channels: {},
} as OpenClawConfig;

const mediaContractRequest = {
  artifactCandidates: ["media-contract-api.js"],
};

function matchesMediaContractRequest(request: {
  artifactCandidates: readonly string[];
  dirName: string;
}): boolean {
  return (
    request.artifactCandidates.length === 1 &&
    request.artifactCandidates[0] === "media-contract-api.js"
  );
}

function createContext(provider: string, accountId = "work"): MsgContext {
  return {
    Body: "hi",
    From: "localchat:work:demo",
    To: "+2000",
    ChatType: "direct",
    Provider: provider,
    AccountId: accountId,
  };
}

beforeEach(() => {
  publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync.mockReset();
  publicSurfaceLoaderMocks.loadPluginPublicArtifactModuleSync.mockReset();
});

describe("channel inbound roots fast path", () => {
  it("prefers media contract artifacts over full channel bootstrap", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync.mockImplementation(
      (request: { artifactCandidates: readonly string[]; dirName: string }) => {
        if (request.dirName === "localchat" && matchesMediaContractRequest(request)) {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/local/${accountId}`,
            ],
            resolveRemoteInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/remote/${accountId}`,
            ],
          };
        }
        return null;
      },
    );

    expect(
      resolveChannelInboundAttachmentRoots({
        cfg,
        ctx: createContext("localchat"),
      }),
    ).toEqual(["/local/work"]);
    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("localchat"),
      }),
    ).toEqual(["/remote/work"]);
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    ).toHaveBeenCalledWith({
      dirName: "localchat",
      ...mediaContractRequest,
    });
  });

  it("does not load broad generic contract artifacts on the media-root path", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync.mockImplementation(
      () => null,
    );

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("mobilechat"),
      }),
    ).toBeUndefined();
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    ).toHaveBeenCalledWith({
      dirName: "mobilechat",
      ...mediaContractRequest,
    });
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    ).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactCandidates: ["contract-api.js"],
    });
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    ).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactCandidates: ["index.js"],
    });
  });

  it("preserves partial media contract modules when a missing resolver is checked first", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync.mockImplementation(
      (request: { artifactCandidates: readonly string[]; dirName: string }) => {
        if (request.dirName === "partialchat" && matchesMediaContractRequest(request)) {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/partial/${accountId}`,
            ],
          };
        }
        return null;
      },
    );

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("partialchat"),
      }),
    ).toBeUndefined();
    expect(
      resolveChannelInboundAttachmentRoots({
        cfg,
        ctx: createContext("partialchat"),
      }),
    ).toEqual(["/partial/work"]);
  });

  it("resolves local inbound roots from explicit channel context", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync.mockImplementation(
      (request: { artifactCandidates: readonly string[]; dirName: string }) => {
        if (request.dirName === "toolchat" && matchesMediaContractRequest(request)) {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/tool/${accountId}`,
            ],
          };
        }
        return null;
      },
    );

    expect(
      resolveChannelInboundAttachmentRootsForChannel({
        cfg,
        channelId: "toolchat",
        accountId: "personal",
      }),
    ).toEqual(["/tool/personal"]);
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    ).toHaveBeenCalledWith({
      dirName: "toolchat",
      ...mediaContractRequest,
    });
  });
});
