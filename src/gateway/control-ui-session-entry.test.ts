import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildControlUiSessionEntryUrl,
  parseControlUiSessionReturnPath,
} from "./control-ui-session-entry-path.js";
import { serveControlUiSessionEntry } from "./control-ui-session-entry.js";
import { AUTH_TOKEN, createRequest, createResponse } from "./server-http.test-harness.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const { authenticate, resolveSession, current } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  resolveSession: vi.fn(),
  current: vi.fn(),
}));
vi.mock(import("./http-auth-utils.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  checkGatewayHttpRequestAuth: authenticate,
  resolveSharedSecretHttpOperatorScopes: () => ["operator.read"],
}));
vi.mock(import("./control-ui-session-path-resolve.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveControlUiSessionPath: resolveSession,
}));
const canonical = "/control/chat/main/launch-12345678aaaa40008000000000000001";
const entry = buildControlUiSessionEntryUrl(canonical, "/control");
const profile = { profileId: "viewer", displayName: "Viewer", hasAvatar: false, updatedAt: 1 };
const projection = {} as SessionRowProjection;
beforeEach(() => {
  current.mockReset().mockReturnValue(true);
  authenticate.mockReset().mockResolvedValue({
    ok: true,
    requestAuth: { authenticatedUserProfile: profile, hasCurrentClientAuthority: current },
  });
  resolveSession
    .mockReset()
    .mockResolvedValue({ key: "agent:main:topic", agentId: "main", isCurrent: current });
});
async function request(
  path = entry,
  mode: "token" | "password" | "trusted-proxy" = "trusted-proxy",
) {
  const response = createResponse();
  const serveApp = vi.fn<Parameters<typeof serveControlUiSessionEntry>[0]["serveApp"]>(
    async () => true,
  );
  await serveControlUiSessionEntry({
    req: createRequest({ path, host: "localhost" }),
    res: response.res,
    basePath: "/control",
    projection,
    auth: { ...AUTH_TOKEN, mode },
    serveApp,
  });
  return { ...response, serveApp };
}
describe("protected canonical session handoff", () => {
  it("preserves the known dashboard presentation parameter after authentication", async () => {
    const path = `${canonical}?dashboard=expanded`;
    const opened = await request(buildControlUiSessionEntryUrl(path, "/control"));
    expect(opened.serveApp).toHaveBeenCalledWith(path, expect.any(Function));
    expect(parseControlUiSessionReturnPath(`${path}&dashboard=expanded`, "/control")).toBeNull();
    expect(parseControlUiSessionReturnPath(`${canonical}?dashboard=other`, "/control")).toBeNull();
  });
  it("preserves composer drafts through the app handoff", async () => {
    const path = `${canonical}?draft=Follow+up&dashboard=expanded&openclaw_mount_recovery=1791731984160`;
    const opened = await request(buildControlUiSessionEntryUrl(path, "/control"));
    expect(opened.serveApp).toHaveBeenCalledWith(path, expect.any(Function));
    expect(parseControlUiSessionReturnPath(`${path}&draft=second`, "/control")).toBeNull();
  });

  it("uses the authenticated profile and grants only exact accessible sessions", async () => {
    const probe = await request(`${entry}&probe=1`);
    expect(probe.res.statusCode).toBe(204);
    expect(probe.serveApp).not.toHaveBeenCalled();
    expect(resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          authenticatedUserProfile: profile,
          connect: expect.objectContaining({ scopes: ["operator.read"] }),
        }),
      }),
    );
    const opened = await request();
    expect(opened.serveApp).toHaveBeenCalledWith(canonical, expect.any(Function));
    expect(opened.setHeader).toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
    const isCurrent = opened.serveApp.mock.calls[0]?.[1];
    current.mockReturnValue(false);
    expect(isCurrent?.()).toBe(false);
  });
  it("keeps denied members on the public reader without an automatic redirect loop", async () => {
    resolveSession.mockResolvedValue(null);
    const probe = await request(`${entry}&probe=1`);
    expect(probe.res.statusCode).toBe(403);
    expect(probe.serveApp).not.toHaveBeenCalled();
    const opened = await request();
    expect(opened.res.statusCode).toBe(303);
    expect(opened.setHeader).toHaveBeenCalledWith("Location", canonical);
    expect(opened.setHeader).not.toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
  });
  it.each(["token", "password"] as const)(
    "keeps explicit %s login on the existing app login gate",
    async (mode) => {
      authenticate.mockResolvedValue({
        ok: false,
        authResult: { ok: false, reason: "token_missing" },
      });
      const opened = await request(entry, mode);
      expect(opened.serveApp).toHaveBeenCalledWith(canonical);
      expect(opened.setHeader).not.toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
      const probe = await request(`${entry}&probe=1`, mode);
      expect(probe.res.statusCode).toBe(401);
      expect(probe.serveApp).not.toHaveBeenCalled();
      expect(resolveSession).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://evil.test/chat/main",
    "/control/chat/main/a\u0000",
    "/control/chat/main/a\u007f",
    "/control/chat/main/a b",
    "//evil.test/chat/main",
    "/control/settings",
    "/chat/main/topic",
    "/control/chat/main/topic?token=secret",
    "/control/chat/main/topic?openclaw_mount_recovery=1&token=secret",
    "/control/chat/main/topic?openclaw_mount_recovery=1&unknown=value",
    "/control/chat/main/topic?openclaw_mount_recovery=1&openclaw_mount_recovery=2",
    "/control/chat/main/topic?openclaw_mount_recovery=",
    "/control/chat/main/topic?openclaw_mount_recovery=invalid",
    "/control/chat/main/../settings",
    "/control/chat/main\\topic",
  ])("rejects unsafe return path %s", async (path) => {
    expect(parseControlUiSessionReturnPath(path, "/control")).toBeNull();
    expect((await request(buildControlUiSessionEntryUrl(path, "/control"))).res.statusCode).toBe(
      404,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });
  it("rejects duplicate and unknown handoff parameters before identity lookup", async () => {
    for (const suffix of [
      "&path=%2Fcontrol%2Fchat%2Fmain",
      "&probe=1&probe=1",
      "&probe=2",
      "&token=ignored",
    ]) {
      expect((await request(entry + suffix)).res.statusCode).toBe(404);
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
});
