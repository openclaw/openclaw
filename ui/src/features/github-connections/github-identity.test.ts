import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { mockRpc } from "../../pages/profile/profile-rpc.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  authorizationCode,
  availableStatus,
  availableIdentity,
  forbidSharedMutation,
  createIdentityFixture,
  createMutationRunner,
  setupRequest,
  sharedTarget,
} from "./github-identity-harness.test-support.ts";
import type { TestGitHubIdentity } from "./github-identity.test-support.ts";

const confirmation = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: confirmation.show,
}));

beforeEach(() => void confirmation.show.mockReset().mockResolvedValue(true));

function authorConfig(systemName: string, agentName: string) {
  const identity = (name: string, letter: string) => ({
    profileId: `ghp_${letter.repeat(32)}`,
    gitAuthor: { name },
  });
  return {
    tools: { github: identity(systemName, "a") },
    agents: { entries: { main: { tools: { github: identity(agentName, "b") } } } },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createController(behavior: { beforeDispatch?: () => void; refreshError?: string } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure") {
        return availableStatus((params.scope as "system" | "agent") ?? "system");
      }
      if (method === "tools.github.status") {
        return availableStatus((params.selectedScope as "system" | "agent") ?? "system");
      }
      throw new Error(`unexpected method ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  const runExternalMutation = createMutationRunner(client, behavior);
  return { ...createIdentityFixture(client, { runExternalMutation }), client, requests };
}

it("keeps independent identity drafts isolated and clears only the inherited target", async () => {
  const { identity, sync, requests } = createController();
  const config = authorConfig("System", "Agent");
  const system = createController();
  sync({ config, scope: "agent" });
  identity.setDraft("token", "agent-token");
  system.sync({ config });
  system.identity.setDraft("token", "system-token");
  identity.setDraft("name", "Active Agent Edit");
  const updatedConfig = authorConfig("Updated System Author", "Updated Agent Author");
  sync({ config: updatedConfig, scope: "agent" });
  expect(identity.read().draft.name).toBe("Active Agent Edit");
  expect(identity.read().draft.token).toBe("agent-token");
  await identity.inherit();
  expect(requests).toContainEqual({
    method: "tools.github.configure",
    params: { scope: "agent", agentId: "main", mode: "inherit" },
  });
  expect(identity.read().scope).toBe("agent");
  expect(identity.read().draft).toEqual({ token: "", name: "", email: "" });
  system.sync({ config });
  expect(system.identity.read().draft).toMatchObject({ name: "System", token: "system-token" });
  expect(system.requests).toEqual([]);
  sync({ config: updatedConfig });
  expect(identity.read().draft.name).toBe("Updated System Author");
});

it.each(["access", "profile"] as const)(
  "deletes a stored handoff when %s changes before dispatch",
  async (change) => {
    const behavior: { beforeDispatch?: () => void } = {};
    const { identity, sync, requests } = createController(behavior);
    behavior.beforeDispatch = () =>
      sync(change === "access" ? { configurable: false } : { target: sharedTarget() });
    sync();
    identity.setDraft("token", "one-use-token");

    await identity.configure();

    expect(requests.map(({ method }) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.delete",
    ]);
    expect(identity.read().configurable).toBe(change === "profile");
    expect(identity.read().error).toBeNull();
  },
);

it("keeps a consumed handoff successful while surfacing its refresh warning", async () => {
  const { identity, sync, requests } = createController({
    refreshError: "authoritative config refresh unavailable",
  });
  sync();
  identity.setDraft("token", "one-use-token");
  await identity.configure();
  expect(requests.map(({ method }) => method)).toEqual([
    "secrets.store.set",
    "tools.github.configure",
  ]);
  expect(requests[0]?.params).toMatchObject({
    value: "one-use-token",
    kind: "secret",
    allowedHosts: [],
  });
  expect(requests[1]?.params).not.toHaveProperty("token");
  expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(requests[1]?.params).toMatchObject({ agentId: "main" });
  expect(identity.read().draft.token).toBe("");
  expect(identity.read().error).toContain("GitHub identity was updated");
  expect(identity.read().error).toContain("authoritative config refresh unavailable");
});

it("keeps UUID generation failures inside configure handling", async () => {
  vi.stubGlobal("crypto", {});
  const { identity, sync, requests } = createController();
  sync();
  identity.setDraft("token", "one-use-token");
  await expect(identity.configure()).resolves.toBeUndefined();
  expect(requests).toEqual([]);
  expect(identity.read().busy).toBe(false);
  await expect(identity.read().mutationCompletion).rejects.toThrow("Web Crypto is required");
});

it("does not dispatch without the required operator scopes", async () => {
  const { identity, sync, requests } = createController();
  sync({
    statusReadable: false,
    configurable: false,
    authorizable: false,
  });
  identity.setDraft("token", "unused-token");
  await identity.verify();
  await identity.configure();
  await identity.inherit();
  expect(requests).toEqual([]);
});

it("requires the explicit new-run disclosure before removing a selected identity", async () => {
  confirmation.show.mockResolvedValueOnce(false);
  const { identity, sync, requests } = createController();
  sync();

  await identity.inherit();

  expect(confirmation.show).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmLabel: "Use native for new runs",
      message: expect.stringContaining("Active runs keep their current identity"),
    }),
  );
  expect(requests).toEqual([]);
});

it("resets the shared profile draft and rejects its pending removal confirmation", async () => {
  const confirmed = createDeferredCore<boolean>();
  confirmation.show.mockReturnValueOnce(confirmed.promise);
  const { identity, sync, requests } = createController();
  const config = authorConfig("System Author", "Agent Author");
  sync({ config });
  identity.setDraft("token", "old-profile-token");
  identity.setDraft("name", "Old Profile Author");
  const removal = identity.inherit();
  sync({ config, target: sharedTarget("profile-b", config) });
  confirmed.resolve(true);
  await removal;
  expect(requests).toEqual([]);
  expect(identity.read().draft).toEqual({ token: "", name: "System Author", email: "" });
});

it("invalidates an in-flight status on effective identity change and verifies once", async () => {
  const first = createDeferredCore<ReturnType<typeof availableStatus>>();
  const second = createDeferredCore<ReturnType<typeof availableStatus>>();
  const responses = [first.promise, second.promise];
  const config = (profileId: string) => ({ tools: { github: { profileId } } });
  const { request, sync, identity } = setupRequest(async () => responses.shift(), {
    context: { config: config("ghp_11111111111111111111111111111111") },
  });
  const initial = identity.verify();
  await Promise.resolve();
  identity.setDraft("name", "dirty author");
  sync({ config: config("ghp_22222222222222222222222222222222") });
  await Promise.resolve();
  expect(identity.read().draft.name).toBe("dirty author");

  await initial;
  expect(identity.read().status).toBeNull();
  first.resolve(availableStatus("system"));
  second.resolve(availableStatus("system"));
  await identity.read().statusCompletion;
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["unused", "pending"])(
  "refreshes only previously requested GitHub status after reconnect (%s)",
  async (initialState) => {
    const first = createDeferredCore<ReturnType<typeof availableStatus>>();
    const currentStatus = availableStatus("system");
    const { request, sync, identity } = setupRequest(
      vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(currentStatus),
    );
    const initial = initialState === "unused" ? undefined : identity.verify();
    identity.setDraft("name", "Unsaved author");
    sync({ connected: false, clientRevision: 2 });
    expect(identity.read().status).toBeNull();
    expect(identity.read().draft.name).toBe("Unsaved author");
    sync({ clientRevision: 3 });
    await Promise.resolve();
    await identity.read().statusCompletion;
    expect(identity.read().loading).toBe(false);
    expect(identity.read().draft.name).toBe("Unsaved author");
    expect(identity.read().status).toEqual(initialState === "unused" ? null : currentStatus);
    first.resolve(availableStatus("agent"));
    await initial;
    expect(identity.read().error).toBeNull();

    const replacement = createTestGatewayClient(request);
    sync({ client: replacement, clientRevision: 4 });
    expect(identity.read().draft.name).toBe("");
    expect(identity.read().status).toBeNull();
    sync({ client: replacement, connected: false, clientRevision: 5 });
    sync({ client: replacement, clientRevision: 6 });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(initialState === "unused" ? 0 : 2);
  },
);

it("rejects status returned for a different agent", async () => {
  const { identity } = setupRequest(async () => ({
    ...availableStatus("system"),
    agentId: "reviewer",
  }));
  await expect(identity.verify()).rejects.toThrow("different target");
  expect(identity.read().status).toBeNull();
});

it("refreshes shared configuration only after successful OAuth polling", async () => {
  vi.useFakeTimers();
  const pollResults = [
    { status: "slow_down" as const, retryAfterMs: 10_000 },
    { status: "success" as const, githubStatus: availableStatus("system") },
  ];
  const request = mockRpc({
    "config.get": () => sourceConfigSnapshot({}, "poll-hash"),
    "tools.github.authorize.start": () => authorizationCode,
    "tools.github.authorize.poll": () => pollResults.shift(),
  });
  const client = createTestGatewayClient(request);
  const runtimeConfig = createRuntimeConfigCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "main",
      hello: gatewayHelloForMethods(["config.set"]),
    },
    subscribe: () => () => undefined,
  });
  await runtimeConfig.ensureLoaded();
  request.mockClear();
  const { identity, sync } = createIdentityFixture(client, {
    runExternalMutation: runtimeConfig.runExternalMutation,
  });
  sync();

  await identity.startAuthorization();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(identity.read().authorization).toMatchObject({ phase: "pending", slowedDown: true });
  expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(identity.read().authorization).toEqual({ phase: "idle" });
  expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
  runtimeConfig.dispose();
});

it.each([
  { label: "selected agent changes", overrides: { agentId: "reviewer" } },
  { label: "connection generation changes", overrides: { clientRevision: 2 } },
  { label: "administrator access is lost", overrides: { authorizable: false } },
  { label: "selected scope changes", overrides: { scope: "agent" as const } },
  { label: "shared profile changes", overrides: { target: sharedTarget() } },
])("cancels the exact authorization when $label", async ({ overrides }) => {
  vi.useFakeTimers();
  const { request, sync, identity } = setupRequest({
    "tools.github.authorize.start": () => authorizationCode,
    "tools.github.authorize.cancel": () => ({ cancelled: true }),
  });
  await identity.startAuthorization();

  sync(overrides);
  await Promise.resolve();

  expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
    requestId: authorizationCode.requestId,
  });
  expect(identity.read().authorization).toEqual({ phase: "idle" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls.some(([method]) => method === "tools.github.authorize.poll")).toBe(
    false,
  );
});

it.each(["too late", "network failure"] as const)(
  "keeps authorization alive after cancellation is %s",
  async (outcome) => {
    vi.useFakeTimers();
    const poll = createDeferredCore<unknown>();
    const { request, identity } = setupRequest(
      {
        "tools.github.authorize.start": () => ({ ...authorizationCode, pollAfterMs: 1_000 }),
        "tools.github.authorize.poll": () =>
          outcome === "too late" ? poll.promise : { status: "pending", retryAfterMs: 1_000 },
        "tools.github.authorize.cancel": () => {
          if (outcome === "network failure") {
            throw new Error("Gateway unavailable");
          }
          return { cancelled: false };
        },
      },
      { mutation: true },
    );
    await identity.startAuthorization();
    if (outcome === "too late") {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "tools.github.authorize.poll",
          expect.anything(),
          expect.anything(),
        ),
      );
    }
    await identity.cancelAuthorization();
    if (outcome === "too late") {
      expect(identity.read().authorization).toMatchObject({ phase: "finishing" });
      poll.resolve({ status: "success", githubStatus: availableStatus("system") });
      await vi.waitFor(() => expect(identity.read().authorization).toEqual({ phase: "idle" }));
      expect(identity.read().status).toEqual(availableStatus("system"));
    } else {
      expect(identity.read().authorization).toMatchObject({
        phase: "cancel_error",
        message: expect.stringContaining("Gateway unavailable"),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request).toHaveBeenCalledWith(
        "tools.github.authorize.poll",
        { requestId: authorizationCode.requestId },
        expect.anything(),
      );
      expect(identity.read().authorization).toMatchObject({ phase: "cancel_error" });
    }
  },
);

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
const system = { ...availableIdentity, source: "system-configured" as const };
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
  const { identity, request } = setup({
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
});

it.each([
  ["profile", { target: { kind: "personal", profileId: "profile-b" } }],
  ["connection", { clientRevision: 2 }],
  ["access", { statusReadable: false, authorizable: false }],
  ["dispose", null],
] as const)("drops delayed status and pending codes after %s changes", async (_change, patch) => {
  const response = createDeferredCore<UsersGitHubStatusResult>();
  const { identity, sync } = setup({ "users.github.status": () => response.promise });
  const verification = identity.verify();
  if (patch) {
    sync(patch);
  } else {
    identity.dispose();
  }
  await verification;
  response.resolve({ personal: { ...connected, pending: code }, system });
  await response.promise;
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
    const response = createDeferredCore<unknown>();
    const delayedMethod = `users.github.${phase === "disconnect" ? phase : `authorize.${phase}`}`;
    const { identity, request, sync } = setup({
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
