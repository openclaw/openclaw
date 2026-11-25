import { afterEach, expect, it, vi } from "vitest";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  authorizationCode,
  availableIdentity,
  setupRequest,
  forbidSharedMutation,
} from "./github-identity-harness.test-support.ts";
import type { TestGitHubIdentity } from "./github-identity.test-support.ts";

const code = { ...authorizationCode, userCode: "SELF-1234", pollAfterMs: 1_000 };
function personalStatus(connected: boolean): PersonalGitHubStatus {
  return {
    state: connected ? "connected" : "disconnected",
    generation: connected ? "11111111-1111-4111-8111-111111111111" : null,
    account: connected ? { accountId: 1234, login: "my-account" } : null,
    accessExpiresAtMs: connected ? 1_900_000_000_000 : null,
    refreshState: connected ? "available" : "not_applicable",
    pending: null,
  };
}
const disconnected = personalStatus(false);
const connected = personalStatus(true);
const system: UsersGitHubStatusResult["system"] = {
  ...availableIdentity,
  source: "system-configured",
  account: { login: "system-bot" },
  gitAuthor: { name: null, email: null },
  accessExpiresAtMs: null,
};
function setup(handlers: Record<string, () => unknown>) {
  const runExternalMutation = vi.fn(forbidSharedMutation);
  return {
    ...setupRequest(handlers, {
      runExternalMutation,
      context: {
        target: { kind: "personal", profileId: "profile-a" },
        configurable: false,
      },
    }),
    runExternalMutation,
  };
}

const expectState = (
  identity: TestGitHubIdentity,
  state: Partial<ReturnType<TestGitHubIdentity["read"]>>,
) => expect(identity.read()).toMatchObject(state);

function expectCode(identity: TestGitHubIdentity) {
  expect(identity.read().authorization).toMatchObject({ phase: "code", userCode: code.userCode });
}

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
});

it("lets an identified reader connect, reconnect and disconnect only their own OAuth account", async () => {
  vi.useFakeTimers();
  let personal = disconnected;
  const { identity, request, runExternalMutation } = setup({
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
  await identity.verify();
  expectState(identity, { system, personal: disconnected, scope: "personal" });
  identity.showPatFallback();
  identity.setDraft("token", "not-a-personal-PAT");
  await identity.configure();
  await identity.inherit();
  flush();
  expectState(identity, { patVisible: false, draft: { token: "", name: "", email: "" } });
  await identity.startAuthorization();
  expectCode(identity);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(identity.read().personal).toEqual(connected);
  await identity.startAuthorization();
  expect(identity.read().personal).toEqual(connected);
  await vi.advanceTimersByTimeAsync(1_000);
  await identity.disconnect();
  expectState(identity, { personal: disconnected, system });
  const read = ["users.github.status", {}];
  const start = ["users.github.authorize.start", {}, expect.anything()];
  const poll = ["users.github.authorize.poll", { requestId: code.requestId }, expect.anything()];
  const calls = [read, start, poll, start, poll, ["users.github.disconnect", {}], read];
  expect(request.mock.calls).toEqual(calls);
  expect(runExternalMutation).not.toHaveBeenCalled();
});

it("restores only the current profile's pending code and honors server retry intervals", async () => {
  vi.useFakeTimers();
  const outcomes = [
    { status: "slow_down", retryAfterMs: 4_000 },
    { status: "network_error", retryAfterMs: 6_000 },
    { status: "success", personal: connected },
  ];
  const { identity, request, runExternalMutation } = setup({
    "users.github.status": () => ({ personal: { ...disconnected, pending: code }, system }),
    "users.github.authorize.poll": () => outcomes.shift(),
    "users.github.authorize.cancel": () => ({ cancelled: true }),
  });
  await identity.verify();
  expectCode(identity);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(identity.read().authorization).toMatchObject({ phase: "pending", slowedDown: true });
  await vi.advanceTimersByTimeAsync(3_999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(identity.read().authorization).toMatchObject({ phase: "network_error" });
  await vi.advanceTimersByTimeAsync(5_999);
  expect(request).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expectState(identity, { authorization: { phase: "idle" }, personal: connected });
  expect(runExternalMutation).not.toHaveBeenCalled();
});

it.each([
  ["profile", { target: { kind: "personal", profileId: "profile-b" } }],
  ["connection", { clientRevision: 2 }],
  ["access", { statusReadable: false, authorizable: false }],
  ["dispose", null],
] as const)("drops delayed status and pending codes after %s changes", async (_change, patch) => {
  const response = deferred<UsersGitHubStatusResult>();
  const { identity, sync } = setup({ "users.github.status": () => response.promise });
  const verification = identity.verify();
  if (patch) {
    sync(patch);
  } else {
    identity.dispose();
  }
  response.resolve({ personal: { ...connected, pending: code }, system });
  await verification;
  expectState(identity, {
    personal: null,
    system: null,
    authorization: { phase: "idle" },
    loading: false,
  });
});

it.each(["start", "poll", "disconnect"] as const)(
  "invalidates an old profile's delayed %s response when another profile takes over",
  async (phase) => {
    vi.useFakeTimers();
    const response = deferred<unknown>();
    const delayedMethod = `users.github.${phase === "disconnect" ? phase : `authorize.${phase}`}`;
    const { identity, request, sync, runExternalMutation } = setup({
      "users.github.status": () => ({ personal: connected, system }),
      "users.github.authorize.start": () => code,
      "users.github.authorize.cancel": () => ({ cancelled: true }),
      [delayedMethod]: () => response.promise,
    });
    await identity.verify();
    const pending = phase === "disconnect" ? identity.disconnect() : identity.startAuthorization();
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
    expectState(identity, { personal: null, authorization: { phase: "idle" }, busy: false });
    if (phase !== "disconnect") {
      expect(request).toHaveBeenCalledWith("users.github.authorize.cancel", {
        requestId: code.requestId,
      });
    }
    expect(runExternalMutation).not.toHaveBeenCalled();
  },
);

it("does not expose personal authorization when durable identity is absent or status fails", async () => {
  const { identity, request, sync } = setup({
    "users.github.status": () => {
      throw new Error("Identity synchronization failed");
    },
  });
  await expect(identity.verify()).rejects.toThrow("Identity synchronization failed");
  expectState(identity, { personal: null, system: null });
  sync({ target: null, authorizable: false, statusReadable: false });
  await identity.startAuthorization();
  await identity.disconnect();
  expect(request).toHaveBeenCalledTimes(1);
});
