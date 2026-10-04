import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import * as avatarImage from "./avatar-image.ts";
import { resetIdentityDraft, saveIdentityDraft, selectIdentityAvatar } from "./identity-actions.ts";

const fileToAvatarDataUrlMock = vi.fn<typeof avatarImage.fileToAvatarDataUrl>();

beforeEach(() => {
  vi.spyOn(avatarImage, "fileToAvatarDataUrl").mockImplementation(fileToAvatarDataUrlMock);
});

afterEach(() => {
  fileToAvatarDataUrlMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function host(): Parameters<typeof resetIdentityDraft>[0] {
  return {
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityError: null,
  };
}

function saveOptions(
  state: ReturnType<typeof host>,
  expectedClient = { request: vi.fn() } as unknown as GatewayBrowserClient,
) {
  return {
    host: state,
    expectedClient,
    agentId: "main",
    agents: {} as ApplicationContext["agents"],
    agentIdentity: {} as ApplicationContext["agentIdentity"],
    canDispatch: () => true,
    isCurrent: () => true,
    onSaved: vi.fn(),
  };
}

describe("agent identity actions", () => {
  it("rejects disabled avatar reads and results finishing after policy changes", async () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: false } };
    const state = host();
    selectIdentityAvatar(state, {} as File, config);
    expect(fileToAvatarDataUrlMock).not.toHaveBeenCalled();
    expect(state.identityError).toBe(uploadsDisabledMessage());

    config.current.uploadsEnabled = true;
    let resolveAvatar!: (value: avatarImage.AvatarDataUrlResult) => void;
    fileToAvatarDataUrlMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAvatar = resolve;
      }),
    );
    selectIdentityAvatar(state, {} as File, config);
    config.current.uploadsEnabled = false;
    resolveAvatar({ ok: true, dataUrl: "data:image/png;base64,aA==" });
    await Promise.resolve();
    expect(state.identityDraft.avatar).toBeNull();
    expect(state.identityError).toBe(uploadsDisabledMessage());
  });

  it("does not dispatch an already selected avatar after uploads are disabled", async () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: false } };
    const state = host();
    state.identityDraft.avatar = "data:image/png;base64,aA==";
    const runExternalMutation = vi.fn();
    await saveIdentityDraft({
      ...saveOptions(state),
      config,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    });
    expect(runExternalMutation).not.toHaveBeenCalled();
    expect(state.identityError).toBe(uploadsDisabledMessage());
  });
  it("keeps unsupported blank edits visible without sending an update", async () => {
    const state = host();
    state.identityDraft.name = "  ";
    const runExternalMutation = vi.fn();
    await saveIdentityDraft({
      ...saveOptions(state),
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    });

    expect(runExternalMutation).not.toHaveBeenCalled();
    expect(state.identityDraft.name).toBe("  ");
  });

  it("drops an avatar decode that completes after the selected agent resets", async () => {
    let resolveAvatar!: (value: avatarImage.AvatarDataUrlResult) => void;
    fileToAvatarDataUrlMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAvatar = resolve;
      }),
    );
    const state = host();

    selectIdentityAvatar(state, {} as File);
    resetIdentityDraft(state);
    resolveAvatar({ ok: true, dataUrl: "data:image/png;base64,stale" });
    await Promise.resolve();

    expect(state.identityDraft.avatar).toBeNull();
  });

  it.each([
    ["unusable", "That image can't be used. Pick an image file up to 2 MB."],
    ["too-detailed", "That image is too detailed to store as an avatar"],
  ] as const)("explains a %s avatar rejection", async (reason, message) => {
    fileToAvatarDataUrlMock.mockResolvedValueOnce({ ok: false, reason });
    const state = host();

    selectIdentityAvatar(state, {} as File);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.identityError).toContain(message);
    expect(state.identityDraft.avatar).toBeNull();
  });

  it("config.set flushes a pending config draft before agents.update and refreshes afterward", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push(method);
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push(method);
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { config, hash };
      }
      if (method === "agents.update") {
        order.push(method);
        config = { ...config, identityName: (params as { name: string }).name };
        hash = "hash-3";
        return {};
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
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
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const agents = {
      refreshList: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agents"];
    const agentIdentity = {
      invalidate: vi.fn(),
      ensure: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agentIdentity"];

    await saveIdentityDraft({
      ...saveOptions(state, client),
      agents,
      agentIdentity,
      runtimeConfig,
    });

    expect(order).toEqual(["config.set", "agents.update", "config.get"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      identityName: "Agent Smith",
    });
    runtimeConfig.dispose();
  });

  it.each(["Connection", "Access"])("does not dispatch after %s changes", async (changed) => {
    const expectedClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runtimeConfig = {
      runExternalMutation: vi.fn(async (task, options) => {
        if (changed === "Access") {
          if (options?.canDispatch?.()) {
            throw new Error("Expected identity access to be revoked.");
          }
          return {
            ok: false as const,
            reason: "unavailable" as const,
            error: options?.dispatchError ?? "Access changed.",
          };
        }
        try {
          return {
            ok: true as const,
            value: await task(client),
            refresh: { ok: true as const },
          };
        } catch (error) {
          return { ok: false as const, reason: "error" as const, error: String(error) };
        }
      }),
    } as unknown as ApplicationContext["runtimeConfig"];

    await saveIdentityDraft({
      ...saveOptions(state, changed === "Connection" ? expectedClient : client),
      runtimeConfig,
      canDispatch: () => changed !== "Access",
    });

    expect(request).not.toHaveBeenCalled();
    expect(state.identityError).toContain(
      `${changed} changed before the agent identity update started.`,
    );
  });

  it("clears a committed identity draft while surfacing a config refresh warning", async () => {
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runExternalMutation = vi.fn(async () => ({
      ok: true as const,
      value: {},
      refresh: { ok: false as const, error: "config.get failed after identity commit" },
    }));

    await saveIdentityDraft({
      ...saveOptions(state),
      agents: {
        refreshList: vi.fn(async () => undefined),
      } as unknown as ApplicationContext["agents"],
      agentIdentity: {
        invalidate: vi.fn(),
        ensure: vi.fn(async () => undefined),
      } as unknown as ApplicationContext["agentIdentity"],
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    });

    expect(runExternalMutation).toHaveBeenCalledOnce();
    expect(state.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
    expect(state.identityError).toContain("config.get failed after identity commit");
  });
});
