import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createGitHubIdentityForTest,
  type TestGitHubIdentity,
} from "./github-identity.test-support.ts";

const confirmation = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: confirmation.show,
}));

beforeEach(() => {
  confirmation.show.mockReset().mockResolvedValue(true);
});

const availableIdentity = {
  source: "agent-override",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "managed-user" },
  gitAuthor: { name: "Agent Author", email: null },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["repo"],
  repositoryGrants: "unknown",
} as const;

function availableStatus(scope: "system" | "agent" = "agent") {
  return {
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: availableIdentity },
    effective: availableIdentity,
  } as const;
}

const authorizationCode = {
  requestId: "github-device-11111111111111111111111111111111",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresInMs: 60_000,
  pollAfterMs: 5_000,
};

function authorConfig(systemName: string, agentName: string) {
  const system = {
    profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    gitAuthor: { name: systemName },
  };
  const agent = {
    profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    gitAuthor: { name: agentName },
  };
  return {
    tools: { github: system },
    agents: { entries: { main: { tools: { github: agent } } } },
  };
}

function createRuntimeConfig(client: GatewayBrowserClient) {
  return createRuntimeConfigCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "main",
      hello: gatewayHelloForMethods(["config.set"]),
    },
    subscribe: () => () => undefined,
  });
}

function createMutationController(client: GatewayBrowserClient) {
  return createGitHubIdentityForTest({
    runExternalMutation: async (task) => ({
      ok: true,
      value: await task(client),
      refresh: { ok: true },
    }),
  });
}

afterEach(() => {
  cleanupSolid();
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
  const runExternalMutation: RuntimeConfigCapability["runExternalMutation"] = async (
    task,
    mutationOptions = {},
  ) => {
    behavior.beforeDispatch?.();
    if (mutationOptions.canDispatch && !mutationOptions.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: mutationOptions.dispatchError ?? "Access changed.",
      };
    }
    try {
      return {
        ok: true,
        value: await task(client),
        refresh: behavior.refreshError ? { ok: false, error: behavior.refreshError } : { ok: true },
      };
    } catch (error) {
      return { ok: false, reason: "error", error: String(error) };
    }
  };
  const host = { runExternalMutation };
  return { controller: createGitHubIdentityForTest(host), client, requests };
}

function createStatusOnlyController(): TestGitHubIdentity {
  return createGitHubIdentityForTest({
    runExternalMutation: async () => ({
      ok: false,
      reason: "unavailable",
      error: "Mutation unavailable in status-only test.",
    }),
  });
}

function sync(
  controller: TestGitHubIdentity,
  client: GatewayBrowserClient,
  config: Record<string, unknown> = {},
  overrides: Partial<Parameters<TestGitHubIdentity["sync"]>[0]> & {
    agentId?: string;
    scope?: "system" | "agent";
  } = {},
) {
  controller.sync({
    client,
    connected: true,
    target: {
      kind: "shared",
      agentId: overrides.agentId ?? "main",
      scope: overrides.scope ?? "system",
      profileId: "profile-a",
      config,
    },
    statusReadable: true,
    configurable: true,
    authorizable: true,
    clientRevision: 1,
    ...overrides,
  });
}

describe("TestGitHubIdentity", () => {
  it("keeps independent controller drafts isolated and clears only the inherited target", async () => {
    const { controller, client, requests } = createController();
    const config = authorConfig("System Author", "Agent Author");
    const system = createController();
    sync(controller, client, config, { scope: "agent" });
    controller.setDraft("token", "agent-token");
    sync(system.controller, system.client, config);
    system.controller.setDraft("token", "system-token");
    sync(controller, client, config, { scope: "agent" });

    expect(controller.read().draft.token).toBe("agent-token");
    await controller.inherit();
    expect(confirmation.show).toHaveBeenCalled();
    expect(requests).toContainEqual({
      method: "tools.github.configure",
      params: { scope: "agent", agentId: "main", mode: "inherit" },
    });
    expect(controller.read().scope).toBe("agent");
    expect(controller.read().draft).toEqual({ token: "", name: "", email: "" });
    sync(system.controller, system.client, config);
    expect(system.controller.read().draft).toMatchObject({
      name: "System Author",
      token: "system-token",
    });
    expect(system.requests).toEqual([]);
  });

  it.each(["access", "profile"] as const)(
    "deletes a stored handoff when %s changes before dispatch",
    async (change) => {
      const behavior: { beforeDispatch?: () => void } = {};
      const { controller, client, requests } = createController(behavior);
      behavior.beforeDispatch = () =>
        sync(
          controller,
          client,
          {},
          change === "access"
            ? { configurable: false }
            : {
                target: {
                  kind: "shared",
                  scope: "system",
                  agentId: "main",
                  config: {},
                  profileId: "profile-b",
                },
              },
        );
      sync(controller, client);
      controller.setDraft("token", "one-use-token");

      await controller.configure();

      expect(requests.map((entry) => entry.method)).toEqual([
        "secrets.store.set",
        "secrets.store.delete",
      ]);
      expect(controller.read().configurable).toBe(change === "profile");
      expect(controller.read().error).toBeNull();
    },
  );

  it("keeps a consumed handoff successful while surfacing its refresh warning", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Uint8Array>(array: T): T => array.fill(0xab),
    });
    const { controller, client, requests } = createController({
      refreshError: "authoritative config refresh unavailable",
    });
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await controller.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "tools.github.configure",
    ]);
    expect(requests[0]?.params).toMatchObject({
      value: "one-use-token",
      kind: "secret",
      allowedHosts: [],
    });
    expect(requests[1]?.params).not.toHaveProperty("token");
    expect(requests[0]?.params.name).toMatch(/^github-setup-[a-f0-9]{32}$/u);
    expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
    expect(controller.read().status).toEqual(availableStatus("system"));
    expect(requests[1]?.params).toMatchObject({ agentId: "main" });
    expect(controller.read().draft.token).toBe("");
    expect(controller.read().error).toContain("GitHub identity was updated");
    expect(controller.read().error).toContain("authoritative config refresh unavailable");
  });

  it("config.set drains drafts before managed and refreshes both edits", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let hashCounter = 1;
    let storedConfig: Record<string, unknown> = {
      pendingEdit: "original",
      tools: { github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      order.push(method);
      if (method === "config.get") {
        return {
          config: storedConfig,
          sourceConfig: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hashCounter += 1;
        return { config: storedConfig, hash: `hash-${hashCounter}` };
      }
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure") {
        const configure = params as { mode: "managed" | "inherit" };
        storedConfig = {
          ...storedConfig,
          tools:
            configure.mode === "managed"
              ? { github: { profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }
              : {},
        };
        hashCounter += 1;
        return availableStatus("system");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runtimeConfig = createRuntimeConfig(client);
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pendingEdit"], "managed");
    const host = {
      runExternalMutation: runtimeConfig.runExternalMutation,
    };
    const controller = createGitHubIdentityForTest(host);
    sync(controller, client, runtimeConfig.state.configForm ?? {});
    const unsubscribe = runtimeConfig.subscribe(() => {
      sync(controller, client, runtimeConfig.state.configForm ?? {});
    });
    try {
      controller.setDraft("token", "one-use-token");
      controller.setDraft("name", "Managed Author");
      await controller.configure();

      expect(order).toEqual([
        "secrets.store.set",
        "config.set",
        "tools.github.configure",
        "config.get",
      ]);
      expect(controller.read().busy).toBe(false);
      expect(controller.read().status).toEqual(availableStatus("system"));
      expect(controller.read().scope).toBe("system");
      expect(controller.read().draft).toEqual({
        token: "",
        name: "Managed Author",
        email: "",
      });
      expect(runtimeConfig.state.configForm).toMatchObject({ pendingEdit: "managed" });
      expect(
        (
          runtimeConfig.state.configForm as {
            tools?: { github?: { profileId?: string } };
          }
        ).tools?.github?.profileId,
      ).toBe("ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps UUID generation failures inside configure handling", async () => {
    vi.stubGlobal("crypto", {});
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await expect(controller.configure()).resolves.toBeUndefined();

    expect(requests).toEqual([]);
    expect(controller.read().busy).toBe(false);
    expect(controller.read().error).toContain("Web Crypto is required");
  });

  it("does not dispatch without the required operator scopes", async () => {
    const { controller, client, requests } = createController();
    sync(
      controller,
      client,
      {},
      {
        statusReadable: false,
        configurable: false,
        authorizable: false,
      },
    );
    controller.setDraft("token", "unused-token");
    await controller.verify();
    await controller.configure();
    await controller.inherit();
    expect(requests).toEqual([]);
  });

  it("refreshes clean drafts without overwriting active edits", () => {
    const { controller, client } = createController();
    sync(controller, client, authorConfig("System One", "Agent One"), { scope: "agent" });
    controller.setDraft("name", "Active Agent Edit");
    sync(controller, client, authorConfig("System Two", "Agent Two"), { scope: "agent" });
    expect(controller.read().draft.name).toBe("Active Agent Edit");
    sync(controller, client, authorConfig("System Two", "Agent Two"));
    expect(controller.read().draft.name).toBe("System Two");
  });

  it("keeps the PAT fallback visible while a save is busy", async () => {
    const pending = createDeferredCore<unknown>();
    const { controller, client } = createController();
    vi.spyOn(client, "request").mockReturnValueOnce(pending.promise);
    sync(controller, client);
    controller.showPatFallback();
    controller.setDraft("token", "synthetic-pat");
    const saving = controller.configure();
    controller.hidePatFallback();
    flush();
    expect(controller.read().patVisible).toBe(true);
    pending.resolve({ ok: true });
    await saving;
  });

  it("requires the explicit new-run disclosure before removing a selected identity", async () => {
    confirmation.show.mockResolvedValueOnce(false);
    const { controller, client, requests } = createController();
    sync(controller, client);

    await controller.inherit();

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
    const { controller, client, requests } = createController();
    const config = authorConfig("System Author", "Agent Author");
    sync(controller, client, config);
    controller.setDraft("token", "old-profile-token");
    controller.setDraft("name", "Old Profile Author");
    const removal = controller.inherit();
    sync(controller, client, config, {
      target: { kind: "shared", scope: "system", agentId: "main", config, profileId: "profile-b" },
    });
    confirmed.resolve(true);
    await removal;
    expect(requests).toEqual([]);
    expect(controller.read().draft).toEqual({ token: "", name: "System Author", email: "" });
  });

  it("invalidates an in-flight status on effective identity change and verifies once", async () => {
    const first = createDeferredCore<ReturnType<typeof availableStatus>>();
    const second = createDeferredCore<ReturnType<typeof availableStatus>>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController();
    const config = (profileId: string) => ({ tools: { github: { profileId } } });
    sync(controller, client, config("ghp_11111111111111111111111111111111"));
    const initial = controller.verify();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    controller.setDraft("name", "dirty author");
    sync(controller, client, config("ghp_22222222222222222222222222222222"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.read().draft.name).toBe("dirty author");

    first.resolve(availableStatus("system"));
    second.resolve(availableStatus("system"));
    await initial;
    await Promise.resolve();
    expect(controller.read().status).toEqual(availableStatus("system"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects status returned for a different agent", async () => {
    const client = {
      request: vi.fn(async () => ({ ...availableStatus("system"), agentId: "reviewer" })),
    } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController();
    sync(controller, client);
    await controller.verify();
    expect(controller.read().status).toBeNull();
    expect(controller.read().error).toContain("different target");
  });

  it("waits for each authoritative poll deadline and adopts successful OAuth status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const pollTimes: number[] = [];
    const pollResults = [
      { status: "slow_down" as const, retryAfterMs: 10_000 },
      { status: "success" as const, githubStatus: availableStatus("system") },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {},
          sourceConfig: {},
          raw: "{}",
          hash: "poll-hash",
          valid: true,
          issues: [],
        };
      }
      if (method === "tools.github.authorize.start") {
        return authorizationCode;
      }
      if (method === "tools.github.authorize.poll") {
        pollTimes.push(Date.now());
        return pollResults.shift();
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runtimeConfig = createRuntimeConfig(client);
    await runtimeConfig.ensureLoaded();
    request.mockClear();
    const controller = createGitHubIdentityForTest({
      runExternalMutation: runtimeConfig.runExternalMutation,
    });
    sync(controller, client);

    await controller.startAuthorization();
    expect(controller.read().authorization).toMatchObject({ phase: "code", userCode: "ABCD-1234" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pollTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toEqual([1_800_000_005_000]);
    expect(controller.read().authorization).toMatchObject({ phase: "pending", slowedDown: true });
    expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(pollTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toEqual([1_800_000_005_000, 1_800_000_015_000]);
    expect(controller.read().status).toEqual(availableStatus("system"));
    expect(controller.read().authorization).toEqual({ phase: "idle" });
    expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
    controller.dispose();
    runtimeConfig.dispose();
  });

  it.each([
    { label: "selected agent changes", overrides: { agentId: "reviewer" } },
    { label: "connection generation changes", overrides: { clientRevision: 2 } },
    { label: "administrator access is lost", overrides: { authorizable: false } },
    { label: "selected scope changes", overrides: { scope: "agent" as const } },
    {
      label: "shared profile changes",
      overrides: {
        target: {
          kind: "shared" as const,
          scope: "system" as const,
          agentId: "main",
          config: {},
          profileId: "profile-b",
        },
      },
    },
  ])("cancels the exact authorization when $label", async ({ overrides }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return authorizationCode;
      }
      return { cancelled: true };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController();
    sync(controller, client);
    await controller.startAuthorization();

    sync(controller, client, {}, overrides);
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
      requestId: authorizationCode.requestId,
    });
    expect(controller.read().authorization).toEqual({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.some(([method]) => method === "tools.github.authorize.poll")).toBe(
      false,
    );
  });

  it("cancels the exact request once when cancellation is repeated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const request = vi.fn(async (method: string) =>
      method === "tools.github.authorize.start" ? authorizationCode : { cancelled: true },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController();
    sync(controller, client);
    await controller.startAuthorization();

    const firstCancel = controller.cancelAuthorization();
    const duplicateCancel = controller.cancelAuthorization();
    await Promise.all([firstCancel, duplicateCancel]);

    expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
      requestId: authorizationCode.requestId,
    });
    expect(
      request.mock.calls.filter(([method]) => method === "tools.github.authorize.cancel"),
    ).toHaveLength(1);
    expect(controller.read().authorization).toEqual({ phase: "idle" });
  });

  it("keeps a too-late cancellation alive and adopts the in-flight success", async () => {
    vi.useFakeTimers();
    const poll = createDeferredCore<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return { ...authorizationCode, pollAfterMs: 1_000 };
      }
      if (method === "tools.github.authorize.poll") {
        return await poll.promise;
      }
      if (method === "tools.github.authorize.cancel") {
        return { cancelled: false };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createMutationController(client);
    sync(controller, client);
    await controller.startAuthorization();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "tools.github.authorize.poll",
        expect.anything(),
        expect.anything(),
      ),
    );

    await controller.cancelAuthorization();
    expect(controller.read().authorization).toMatchObject({ phase: "finishing" });
    poll.resolve({ status: "success", githubStatus: availableStatus("system") });
    await vi.waitFor(() => expect(controller.read().authorization).toEqual({ phase: "idle" }));

    expect(controller.read().status).toEqual(availableStatus("system"));
  });

  it("keeps authorization pending and surfaces a cancellation network failure", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return authorizationCode;
      }
      if (method === "tools.github.authorize.cancel") {
        throw new Error("Gateway unavailable");
      }
      if (method === "tools.github.authorize.poll") {
        return { status: "pending", retryAfterMs: 5_000 };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createMutationController(client);
    sync(controller, client);
    await controller.startAuthorization();

    await controller.cancelAuthorization();
    expect(controller.read().authorization).toMatchObject({
      phase: "cancel_error",
      message: expect.stringContaining("Gateway unavailable"),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledWith(
      "tools.github.authorize.poll",
      { requestId: authorizationCode.requestId },
      expect.anything(),
    );
    expect(controller.read().authorization).toMatchObject({ phase: "cancel_error" });
  });
});
