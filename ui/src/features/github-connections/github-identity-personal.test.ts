import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
  UsersGitHubAuthorizeStartResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createGitHubIdentityForTest,
  type TestGitHubIdentity,
} from "./github-identity.test-support.ts";

const code = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userCode: "SELF-1234",
  verificationUri: "https://github.com/login/device",
  expiresInMs: 60_000,
  pollAfterMs: 1_000,
} satisfies UsersGitHubAuthorizeStartResult;
const disconnected: PersonalGitHubStatus = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
};
const connected: PersonalGitHubStatus = {
  ...disconnected,
  state: "connected",
  generation: "11111111-1111-4111-8111-111111111111",
  account: { accountId: 1234, login: "my-account" },
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
};
const system: UsersGitHubStatusResult["system"] = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-bot" },
  gitAuthor: { name: null, email: null },
  evidence: "github-api",
  accessExpiresAtMs: null,
  refreshState: "available",
  oauthScopes: ["repo"],
  repositoryGrants: "unknown",
};
function setup(handlers: Record<string, () => unknown>) {
  const request = vi.fn(async (method: string) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`unexpected method ${method}`);
    }
    return handler();
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const runExternalMutation = vi.fn(async () => {
    throw new Error("Personal flow touched shared config");
  });
  const controller = createGitHubIdentityForTest({ runExternalMutation });
  const sync = (overrides: Partial<Parameters<TestGitHubIdentity["sync"]>[0]> = {}) =>
    controller.sync({
      client,
      connected: true,
      permissionsReady: overrides.connected ?? true,
      clientRevision: 1,
      target: { kind: "personal", profileId: "profile-a" },
      statusReadable: true,
      configurable: false,
      authorizable: true,
      ...overrides,
    });
  sync();
  return { controller, request, sync, runExternalMutation };
}

function expectState(
  controller: TestGitHubIdentity,
  state: Partial<ReturnType<TestGitHubIdentity["read"]>>,
) {
  expect(controller.read()).toEqual(expect.objectContaining(state));
}

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
});

describe("personal GitHub connection ownership", () => {
  it("lets an identified reader connect, reconnect and disconnect only their own OAuth account", async () => {
    vi.useFakeTimers();
    let personal = disconnected;
    const { controller, request, runExternalMutation } = setup({
      "users.github.status": () => ({ personal, system }),
      "users.github.authorize.start": () => code,
      "users.github.authorize.poll": () => {
        personal = connected;
        return { status: "success", personal };
      },
      "users.github.disconnect": () => {
        personal = disconnected;
        return { disconnected: true };
      },
    });
    await controller.verify();
    expectState(controller, { system, personal: disconnected, scope: "personal" });
    controller.showPatFallback();
    controller.setDraft("token", "not-a-personal-PAT");
    await controller.configure();
    await controller.inherit();
    flush();
    expectState(controller, { patVisible: false, draft: { token: "", name: "", email: "" } });
    await controller.startAuthorization();
    expect(controller.read().authorization).toMatchObject({
      phase: "code",
      userCode: code.userCode,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.read().personal).toEqual(connected);
    await controller.startAuthorization();
    expect(controller.read().personal).toEqual(connected);
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.disconnect();
    expectState(controller, { personal: disconnected, system });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "users.github.status",
      "users.github.authorize.start",
      "users.github.authorize.poll",
      "users.github.authorize.start",
      "users.github.authorize.poll",
      "users.github.disconnect",
      "users.github.status",
    ]);
    expect(request).toHaveBeenCalledWith("users.github.authorize.start", {}, expect.anything());
    expect(request).toHaveBeenCalledWith(
      "users.github.authorize.poll",
      { requestId: code.requestId },
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith("users.github.disconnect", {});
    expect(runExternalMutation).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("restores only the current profile's pending code and honors server retry intervals", async () => {
    vi.useFakeTimers();
    const outcomes = [
      { status: "slow_down", retryAfterMs: 4_000 },
      { status: "network_error", retryAfterMs: 6_000 },
      { status: "success", personal: connected },
    ];
    const { controller, request, runExternalMutation } = setup({
      "users.github.status": () => ({ personal: { ...disconnected, pending: code }, system }),
      "users.github.authorize.poll": () => outcomes.shift(),
      "users.github.authorize.cancel": () => ({ cancelled: true }),
    });
    await controller.verify();
    expect(controller.read().authorization).toMatchObject({
      phase: "code",
      userCode: code.userCode,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.read().authorization).toMatchObject({ phase: "pending", slowedDown: true });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.read().authorization).toMatchObject({ phase: "network_error" });
    await vi.advanceTimersByTimeAsync(5_999);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expectState(controller, { authorization: { phase: "idle" }, personal: connected });
    expect(runExternalMutation).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["profile", "connection", "access", "dispose"] as const)(
    "drops delayed status and pending codes after %s changes",
    async (change) => {
      const response = deferred<UsersGitHubStatusResult>();
      const { controller, sync } = setup({ "users.github.status": () => response.promise });
      const verification = controller.verify();
      if (change === "profile") {
        sync({ target: { kind: "personal", profileId: "profile-b" } });
      }
      if (change === "connection") {
        sync({ clientRevision: 2 });
      }
      if (change === "access") {
        sync({ statusReadable: false, authorizable: false });
      }
      if (change === "dispose") {
        controller.dispose();
      }
      response.resolve({ personal: { ...connected, pending: code }, system });
      await verification;
      expectState(controller, {
        personal: null,
        system: null,
        authorization: { phase: "idle" },
        loading: false,
      });
      controller.dispose();
    },
  );

  it.each(["start", "poll", "disconnect"] as const)(
    "invalidates an old profile's delayed %s response when another profile takes over",
    async (phase) => {
      vi.useFakeTimers();
      const response = deferred<unknown>();
      const delayedMethod = `users.github.${phase === "disconnect" ? phase : `authorize.${phase}`}`;
      const { controller, request, sync, runExternalMutation } = setup({
        "users.github.status": () => ({ personal: connected, system }),
        "users.github.authorize.start": () => code,
        "users.github.authorize.cancel": () => ({ cancelled: true }),
        [delayedMethod]: () => response.promise,
      });
      await controller.verify();
      const pending =
        phase === "disconnect" ? controller.disconnect() : controller.startAuthorization();
      if (phase === "poll") {
        await pending;
        await vi.advanceTimersByTimeAsync(1_000);
      }
      sync({ target: { kind: "personal", profileId: "profile-b" } });
      response.resolve(
        phase === "start"
          ? code
          : phase === "poll"
            ? { status: "success", personal: connected }
            : { disconnected: true },
      );
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expectState(controller, { personal: null, authorization: { phase: "idle" }, busy: false });
      if (phase !== "disconnect") {
        expect(request).toHaveBeenCalledWith("users.github.authorize.cancel", {
          requestId: code.requestId,
        });
      }
      expect(runExternalMutation).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it("does not expose personal authorization when durable identity is absent or status fails", async () => {
    const { controller, request, sync } = setup({
      "users.github.status": () => {
        throw new Error("Identity synchronization failed");
      },
    });
    await controller.verify();
    expect(controller.read().error).toContain("Identity synchronization failed");
    expectState(controller, { personal: null, system: null });
    sync({ target: null, authorizable: false, statusReadable: false });
    await controller.startAuthorization();
    await controller.disconnect();
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
