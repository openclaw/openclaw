import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUserProfileAvatarHttpRequest } from "./user-profiles-http.js";

const authorizeScopedGatewayHttpRequestOrReply = vi.hoisted(() => vi.fn());
const getProfileAvatar = vi.hoisted(() => vi.fn());

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeScopedGatewayHttpRequestOrReply,
}));
vi.mock("../state/user-profiles.js", () => ({
  formatUserProfileAvatarEtag: (sha256: string) => `"${sha256}"`,
  getProfileAvatar,
}));

function response() {
  return {
    end: vi.fn(),
    setHeader: vi.fn(),
    writeHead: vi.fn(),
  } as unknown as ServerResponse;
}

function request(path: string, headers: Record<string, string> = {}) {
  return { method: "GET", url: path, headers } as unknown as IncomingMessage;
}

describe("profile avatar HTTP endpoint", () => {
  beforeEach(() => {
    authorizeScopedGatewayHttpRequestOrReply.mockReset();
    getProfileAvatar.mockReset();
    authorizeScopedGatewayHttpRequestOrReply.mockResolvedValue({});
  });

  it("serves avatars with their stored MIME type and updated-at ETag", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/webp",
      sha256: "first-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(request("/api/users/profile-1/avatar"), res, {
      auth: {} as never,
    });

    expect(authorizeScopedGatewayHttpRequestOrReply).toHaveBeenCalledWith(
      expect.objectContaining({ operatorMethod: "users.list" }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/webp", ETag: '"first-hash"' }),
    );
    expect(res.end).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("answers a matching ETag without a body", async () => {
    getProfileAvatar.mockReturnValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
      sha256: "current-hash",
      updatedAt: 42,
    });
    const res = response();

    await handleUserProfileAvatarHttpRequest(
      request("/api/users/profile-1/avatar", { "if-none-match": '"current-hash"' }),
      res,
      { auth: {} as never },
    );

    expect(res.writeHead).toHaveBeenCalledWith(304, { ETag: '"current-hash"' });
    expect(res.end).toHaveBeenCalledWith();
  });
});
