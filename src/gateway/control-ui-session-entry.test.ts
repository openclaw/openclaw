import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildControlUiSessionEntryUrl as entryUrl,
  parseControlUiSessionReturnPath as parseReturn,
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
  authorizeControlUiReadRequestOrReply: authenticate,
}));
vi.mock(import("./control-ui-session-path-resolve.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveControlUiSessionPath: resolveSession,
}));
const canonical = "/control/chat/main/launch-12345678aaaa40008000000000000001";
const entry = entryUrl(canonical, "/control");
const profile = { profileId: "viewer", displayName: "Viewer", hasAvatar: false, updatedAt: 1 };
const projection = {} as SessionRowProjection;
beforeEach(() => {
  current.mockReset().mockReturnValue(true);
  authenticate.mockReset().mockResolvedValue({
    authenticatedUserProfile: profile,
    hasCurrentClientAuthority: current,
    operatorScopes: ["operator.read"],
    revalidate: async () => {},
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
  it.each([
    ["dashboard=expanded", "dashboard=expanded"],
    ["draft=Follow+up&dashboard=expanded&openclaw_mount_recovery=1791731984160", "draft=second"],
  ])("preserves %s through the app handoff, rejecting duplicates", async (query, duplicate) => {
    const path = `${canonical}?${query}`;
    const opened = await request(entryUrl(path, "/control"));
    expect(opened.serveApp).toHaveBeenCalledWith(path, expect.any(Function));
    expect(parseReturn(`${path}&${duplicate}`, "/control")).toBeNull();
  });

  it.each([
    "__openclawSessionFacePreference=1",
    "__openclawSessionKey=agent%3Amain%3Adashboard%3A11111111-2222-3333-4444-555555555555&__openclawComposerFocus=1",
  ])("preserves navigation hints %s without changing the authenticated target", async (query) => {
    const path = `${canonical}?${query}`;
    const opened = await request(entryUrl(path, "/control"));
    expect(opened.serveApp).toHaveBeenCalledWith(path, expect.any(Function));
    expect(parseReturn(path, "/control")).toEqual(parseReturn(canonical, "/control"));
  });

  it("uses the authenticated profile and grants only exact accessible sessions", async () => {
    const probe = await request(`${entry}&probe=1`);
    expect(probe.res.statusCode).toBe(204);
    expect(probe.serveApp).not.toHaveBeenCalled();
    expect(resolveSession.mock.calls[0]?.[0]).toMatchObject({
      client: { authenticatedUserProfile: profile, connect: { scopes: ["operator.read"] } },
    });
    const opened = await request();
    expect(opened.serveApp).toHaveBeenCalledWith(canonical, expect.any(Function));
    expect(opened.setHeader).toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
    current.mockReturnValue(false);
    expect(opened.serveApp.mock.calls[0]?.[1]?.()).toBe(false);
  });
  it("ends a denied handoff without redirecting into another reader probe", async () => {
    resolveSession.mockResolvedValue(null);
    const probe = await request(`${entry}&probe=1`);
    expect(probe.res.statusCode).toBe(403);
    expect(probe.serveApp).not.toHaveBeenCalled();
    const opened = await request();
    expect(opened.res.statusCode).toBe(403);
    expect(opened.setHeader).not.toHaveBeenCalledWith("Location", expect.anything());
    expect(opened.getBody()).toContain("Session unavailable");
    expect(opened.setHeader).not.toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
  });
  it("keeps explicit password login on the existing app login gate", async () => {
    authenticate.mockImplementation(async ({ res, replyOnFailure }) => {
      if (replyOnFailure) {
        res.statusCode = 401;
        res.end();
      }
      return null;
    });
    const opened = await request(entry, "password");
    expect(opened.serveApp).toHaveBeenCalledWith(canonical);
    expect(opened.setHeader).not.toHaveBeenCalledWith("X-OpenClaw-Session-Entry", "1");
    const probe = await request(`${entry}&probe=1`, "password");
    expect(probe.res.statusCode).toBe(401);
    expect(probe.serveApp).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
  });
  it.each([
    "https://evil.test/chat/main",
    "/control/chat/main/a\u0000",
    "/control/chat/main/a b",
    "//evil.test/chat/main",
    "/control/settings",
    "/chat/main/topic",
    "/control/chat/main/topic?openclaw_mount_recovery=1&token=secret",
    "/control/chat/main/topic?openclaw_mount_recovery=1&openclaw_mount_recovery=2",
    "/control/chat/main/topic?openclaw_mount_recovery=invalid",
    "/control/chat/main?__openclawSessionFacePreference=1&__openclawSessionFacePreference=1",
    "/control/chat/main?__openclawSessionKey=first&__openclawSessionKey=second",
    "/control/chat/main?__openclawSessionKey=",
    "/control/chat/main?__openclawComposerFocus=1&__openclawComposerFocus=1",
    "/control/chat/main?__openclawComposerFocus=0",
    "/control/chat/main?__openclawComposerFocus=",
    "/control/chat/main?__openclawSessionFacePreference=0",
    "/control/chat/main?__openclawSessionFacePreference=",
    "/control/chat/main?__openclawSessionFacePreference=1&token=secret",
    `${canonical}?dashboard=other`,
    "/control/chat/main/../settings",
    "/control/chat/main\\topic",
  ])("rejects unsafe return path %s", async (path) => {
    expect(parseReturn(path, "/control")).toBeNull();
    expect((await request(entryUrl(path, "/control"))).res.statusCode).toBe(404);
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
