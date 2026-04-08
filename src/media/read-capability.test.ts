import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  createAgentScopedHostMediaReadFile,
  resolveAgentScopedOutboundMediaAccess,
} from "./read-capability.js";

describe("createAgentScopedHostMediaReadFile", () => {
  it("returns a root-scoped readFile when tools.fs.roots is configured", () => {
    const result = createAgentScopedHostMediaReadFile({
      cfg: {
        tools: {
          fs: {
            roots: [{ path: "/data/shared", kind: "dir", access: "ro" }],
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toBeTypeOf("function");
  });

  it("rejects reads outside configured roots", async () => {
    const readFile = createAgentScopedHostMediaReadFile({
      cfg: {
        tools: {
          fs: {
            roots: [{ path: "/tmp", kind: "dir", access: "ro" }],
          },
        },
      } as OpenClawConfig,
    });

    await expect(readFile!("/etc/passwd")).rejects.toThrow(/outside/);
  });

  it("returns undefined when tools.fs.roots is empty (deny-all)", () => {
    const result = createAgentScopedHostMediaReadFile({
      cfg: {
        tools: {
          fs: {
            roots: [],
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toBeUndefined();
  });
});

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
}));

describe("resolveAgentScopedOutboundMediaAccess", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves caller-provided workspaceDir from mediaAccess", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {} as OpenClawConfig,
      mediaAccess: { workspaceDir: "/tmp/media-workspace" },
    });

    expect(result).toMatchObject({ workspaceDir: "/tmp/media-workspace" });
  });

  it("preserves empty localRoots as deny-all when tools.fs.roots is []", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          fs: {
            roots: [],
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toHaveProperty("localRoots");
    expect(result.localRoots).toEqual([]);
    expect(result.readFile).toBeUndefined();
  });

  it("prefers explicit workspaceDir over mediaAccess.workspaceDir", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {} as OpenClawConfig,
      workspaceDir: "/tmp/explicit-workspace",
      mediaAccess: { workspaceDir: "/tmp/media-workspace" },
    });

    expect(result).toMatchObject({ workspaceDir: "/tmp/explicit-workspace" });
  });

  it("does not enable host reads when sender group policy denies read", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
      },
      channels: {
        requestchat: {
          groups: {
            ops: {
              toolsBySender: {
                "id:attacker": {
                  deny: ["read"],
                },
              },
            },
          },
        },
      },
    };

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      sessionKey: "agent:main:requestchat:group:ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
      // Production call sites set messageProvider: undefined when sessionKey is present;
      // resolveGroupToolPolicy derives channel from the session key instead.
      requesterSenderId: "attacker",
    });

    expect(result.readFile).toBeUndefined();
    expect(result.localRoots).not.toContain("/Users/peter/Pictures");
  });

  it("keeps host reads enabled when sender group policy allows read", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
      },
      channels: {
        requestchat: {
          groups: {
            ops: {
              toolsBySender: {
                "id:trusted-user": {
                  allow: ["read"],
                },
              },
            },
          },
        },
      },
    };

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      sessionKey: "agent:main:requestchat:group:ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
      requesterSenderId: "trusted-user",
    });

    expect(result.readFile).toBeTypeOf("function");
    expect(result.localRoots).toContain("/Users/peter/Pictures");
  });

  it("keeps host reads enabled when no group policy applies", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          allow: ["read"],
        },
      } as OpenClawConfig,
      messageProvider: "requestchat",
      requesterSenderId: "trusted-user",
    });

    expect(result.readFile).toBeTypeOf("function");
  });

  it("keeps host reads enabled for DM sender when no group context exists", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          allow: ["read"],
        },
        channels: {
          requestchat: {
            groups: {
              ops: {
                toolsBySender: {
                  "id:dm-sender": {
                    deny: ["read"],
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      messageProvider: "requestchat",
      requesterSenderId: "dm-sender",
    });

    expect(result.readFile).toBeTypeOf("function");
  });
});
