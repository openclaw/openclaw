import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeGatewayConnect: vi.fn(async () => ({ ok: true })),
  getBearerToken: vi.fn(() => "token"),
  listAgentIds: vi.fn(() => ["test-agent"]),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/ws"),
  applyAgentConfig: vi.fn((_cfg: unknown, _params: unknown) => ({ next: true })),
  writeConfigFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("./auth.js", () => ({
  authorizeGatewayConnect: mocks.authorizeGatewayConnect,
}));

vi.mock("./http-utils.js", () => ({
  getBearerToken: mocks.getBearerToken,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
}));

vi.mock("../config/config.js", () => ({
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = { ...actual, mkdir: mocks.mkdir, writeFile: mocks.writeFile };
  return { ...patched, default: patched };
});

const { handleControlUiAvatarUploadRequest } = await import("./control-ui.js");

function makeRes() {
  const state: { statusCode?: number; headers: Record<string, string>; body: string } = {
    headers: {},
    body: "",
  };
  const res = {
    setHeader: (k: string, v: string) => {
      state.headers[k.toLowerCase()] = v;
    },
    end: (chunk?: string) => {
      if (typeof chunk === "string") {
        state.body += chunk;
      }
    },
  } as unknown as ServerResponse;
  return { res, state };
}

function makeReq(opts: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
}) {
  const req = Readable.from(opts.body ? [opts.body] : []) as unknown as IncomingMessage;
  (req as unknown as { url: string }).url = opts.url;
  (req as unknown as { method: string }).method = opts.method;
  (req as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {};
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

describe("control ui avatar upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeGatewayConnect.mockResolvedValue({ ok: true });
    mocks.listAgentIds.mockReturnValue(["test-agent"]);
  });

  it("returns false when path does not match", async () => {
    const { res } = makeRes();
    const req = makeReq({ url: "/nope", method: "POST" });
    const handled = await handleControlUiAvatarUploadRequest(req, res, {
      basePath: "",
      config: {},
      auth: { mode: "token", token: "x", allowTailscale: false },
    });
    expect(handled).toBe(false);
  });

  it("rejects when unauthorized", async () => {
    mocks.authorizeGatewayConnect.mockResolvedValue({ ok: false });
    const { res, state } = makeRes();
    const req = makeReq({
      url: "/avatar/test-agent",
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "image/png" },
      body: Buffer.from([1, 2, 3]),
    });
    const handled = await handleControlUiAvatarUploadRequest(req, res, {
      basePath: "",
      config: {},
      auth: { mode: "token", token: "x", allowTailscale: false },
    });
    expect(handled).toBe(true);
    expect(state.body).toContain("Unauthorized");
  });

  it("stores an avatar file under workspace and updates config identity", async () => {
    const { res } = makeRes();
    const req = makeReq({
      url: "/avatar/test-agent",
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "image/png" },
      body: Buffer.from([1, 2, 3]),
    });
    const handled = await handleControlUiAvatarUploadRequest(req, res, {
      basePath: "",
      config: { agents: { list: [{ id: "test-agent" }] } },
      auth: { mode: "token", token: "x", allowTailscale: false },
    });
    expect(handled).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/ws/avatars/avatar.png", expect.any(Buffer));
    expect(mocks.applyAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: "test-agent",
        identity: { avatar: "avatars/avatar.png" },
      }),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith({ next: true });
  });
});
