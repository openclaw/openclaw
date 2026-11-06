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

const cfg: OpenClawConfig = { channels: {} };
const loader = publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync;
const requestFor = (dirName: string) => ({
  dirName,
  artifactCandidates: ["media-contract-api.js"],
});
type RootResolver = (params: { accountId?: string }) => string[];
function installContract(
  channel: string,
  contract: {
    resolveInboundAttachmentRoots: RootResolver;
    resolveRemoteInboundAttachmentRoots?: RootResolver;
  },
) {
  loader.mockImplementation(
    (request: { artifactCandidates: readonly string[]; dirName: string }) =>
      request.dirName === channel &&
      request.artifactCandidates.length === 1 &&
      request.artifactCandidates[0] === "media-contract-api.js"
        ? contract
        : null,
  );
}

const contextFor = (Provider: string): { cfg: OpenClawConfig; ctx: MsgContext } => ({
  cfg,
  ctx: { Provider, AccountId: "work" },
});

beforeEach(() => {
  loader.mockReset();
  publicSurfaceLoaderMocks.loadPluginPublicArtifactModuleSync.mockReset();
});

describe("channel inbound roots fast path", () => {
  it("prefers media contract artifacts over full channel bootstrap", () => {
    installContract("localchat", {
      resolveInboundAttachmentRoots: ({ accountId }) => [`/local/${accountId}`],
      resolveRemoteInboundAttachmentRoots: ({ accountId }) => [`/remote/${accountId}`],
    });

    expect(resolveChannelInboundAttachmentRoots(contextFor("localchat"))).toEqual(["/local/work"]);
    expect(resolveChannelRemoteInboundAttachmentRoots(contextFor("localchat"))).toEqual([
      "/remote/work",
    ]);
    expect(loader).toHaveBeenCalledWith(requestFor("localchat"));
  });

  it("does not load broad generic contract artifacts on the media-root path", () => {
    loader.mockReturnValue(null);

    expect(resolveChannelRemoteInboundAttachmentRoots(contextFor("mobilechat"))).toBeUndefined();
    expect(loader).toHaveBeenCalledWith(requestFor("mobilechat"));
    expect(loader).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactCandidates: ["contract-api.js"],
    });
    expect(loader).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactCandidates: ["index.js"],
    });
  });

  it("preserves partial media contract modules when a missing resolver is checked first", () => {
    installContract("partialchat", {
      resolveInboundAttachmentRoots: ({ accountId }) => [`/partial/${accountId}`],
    });

    expect(resolveChannelRemoteInboundAttachmentRoots(contextFor("partialchat"))).toBeUndefined();
    expect(resolveChannelInboundAttachmentRoots(contextFor("partialchat"))).toEqual([
      "/partial/work",
    ]);
  });

  it("resolves local inbound roots from explicit channel context", () => {
    installContract("toolchat", {
      resolveInboundAttachmentRoots: ({ accountId }) => [`/tool/${accountId}`],
    });

    expect(
      resolveChannelInboundAttachmentRootsForChannel({
        cfg,
        channelId: "toolchat",
        accountId: "personal",
      }),
    ).toEqual(["/tool/personal"]);
    expect(loader).toHaveBeenCalledWith(requestFor("toolchat"));
  });
});
