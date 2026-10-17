import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createConfigServerMock,
  createGatewayHarness,
} from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import * as avatarImage from "./avatar-image.ts";
import {
  resetIdentityDraft,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityDraftField,
  setIdentityAvatar,
} from "./identity-actions.ts";

const fileToAvatarDataUrlMock = vi.fn<typeof avatarImage.fileToAvatarDataUrl>();
type IdentityHost = Parameters<typeof resetIdentityDraft>[0];
type Mutation = ApplicationContext["runtimeConfig"]["runExternalMutation"];

beforeEach(() => {
  vi.spyOn(avatarImage, "fileToAvatarDataUrl").mockImplementation(fileToAvatarDataUrlMock);
});

afterEach(() => {
  fileToAvatarDataUrlMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function host(draft: Partial<IdentityHost["identityDraft"]> = {}): IdentityHost {
  return {
    identityDraft: { name: null, emoji: null, avatar: null, ...draft },
    identitySaving: false,
    identityError: null,
  };
}

function saveWithMutation(
  state: IdentityHost,
  runExternalMutation: (...args: Parameters<Mutation>) => ReturnType<Mutation> = vi.fn(),
  options: Partial<Parameters<typeof saveIdentityDraft>[0]> = {},
) {
  const agentIdentity = { invalidate() {}, async ensure() {} };
  return saveIdentityDraft({
    host: state,
    expectedClient: createTestGatewayClient(vi.fn()),
    agentId: "main",
    agents: { async refreshList() {} } as unknown as ApplicationContext["agents"],
    agentIdentity: agentIdentity as unknown as ApplicationContext["agentIdentity"],
    canDispatch: () => true,
    isCurrent: () => true,
    onSaved: vi.fn(),
    runtimeConfig: { runExternalMutation } as ApplicationContext["runtimeConfig"],
    ...options,
  });
}

function uploadsConfig(uploadsEnabled: boolean) {
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  return { ...base, current: { ...base.current, uploadsEnabled } };
}

function pendingAvatar() {
  const pending = createDeferred<avatarImage.AvatarDataUrlResult>();
  fileToAvatarDataUrlMock.mockReturnValueOnce(pending.promise);
  return pending;
}

it.each(["generated avatar", "agent reset"])("retires an older upload after %s", async (change) => {
  const state = host();
  const upload = pendingAvatar();
  selectIdentityAvatar(state, {} as File);
  const avatar = change === "generated avatar" ? "data:image/webp;base64,YXZhdGFy" : null;
  if (avatar) {
    setIdentityAvatar(state, avatar);
  } else {
    resetIdentityDraft(state);
  }
  upload.resolve({ ok: true, dataUrl: "data:image/png;base64,b2xk" });
  await Promise.resolve();
  expect(state.identityDraft.avatar).toBe(avatar);
});

it("queues persistence only after a valid uploaded avatar is ready", async () => {
  const state = host();
  const onSelected = vi.fn();
  fileToAvatarDataUrlMock.mockResolvedValueOnce({
    ok: true,
    dataUrl: "data:image/png;base64,aA==",
  });
  selectIdentityAvatar(state, {} as File, undefined, onSelected);
  expect(onSelected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(onSelected).toHaveBeenCalledOnce());
  expect(state.identityDraft.avatar).toBe("data:image/png;base64,aA==");
});

it("rejects disabled avatar reads and results finishing after policy changes", async () => {
  const config = uploadsConfig(false);
  const state = host();
  selectIdentityAvatar(state, {} as File, config);
  expect(fileToAvatarDataUrlMock).not.toHaveBeenCalled();
  expect(state.identityError).toBe(uploadsDisabledMessage());

  config.current.uploadsEnabled = true;
  const upload = pendingAvatar();
  selectIdentityAvatar(state, {} as File, config);
  config.current.uploadsEnabled = false;
  upload.resolve({ ok: true, dataUrl: "data:image/png;base64,aA==" });
  await Promise.resolve();
  expect(state.identityDraft.avatar).toBeNull();
  expect(state.identityError).toBe(uploadsDisabledMessage());
});

it.each([
  { draft: { avatar: "data:image/png;base64,aA==" }, error: uploadsDisabledMessage() },
  { draft: { name: "  " }, error: null },
])("does not dispatch a blocked identity draft: $draft", async ({ draft, error }) => {
  const state = host(draft);
  const runExternalMutation = vi.fn();
  await saveWithMutation(state, runExternalMutation, { config: uploadsConfig(false) });
  expect(runExternalMutation).not.toHaveBeenCalled();
  expect(state).toMatchObject({ identityDraft: draft, identityError: error });
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
  const server = createConfigServerMock();
  await server.request("config.set", { raw: '{"pending":false}', baseHash: "hash-1" });
  const request = vi.fn(async (method: string, params?: unknown) => {
    order.push(method);
    if (method === "agents.update") {
      const { config } = (await server.request("config.get")) as ConfigSnapshot;
      return server.request("config.set", {
        raw: JSON.stringify({ ...config, identityName: (params as { name: string }).name }),
        baseHash: server.currentHash(),
      });
    }
    if (method !== "config.get" && method !== "config.set") {
      throw new Error(`Unexpected method ${method}`);
    }
    const result = (await server.request(method, params)) as ConfigSnapshot;
    return method === "config.get" ? { ...result, sourceConfig: result.config } : result;
  });
  const client = createTestGatewayClient(request);
  const { gateway, publish } = createGatewayHarness(client);
  publish(true, client, gatewayHelloForMethods(["config.set"]));
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  await runtimeConfig.ensureLoaded();
  order.length = 0;
  runtimeConfig.patchForm(["pending"], true);
  const state = host({ name: "Agent Smith" });

  await saveWithMutation(state, undefined, { expectedClient: client, runtimeConfig });

  expect(order).toEqual(["config.set", "agents.update", "config.get"]);
  expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-4");
  expect(runtimeConfig.state.configForm).toMatchObject({
    pending: true,
    identityName: "Agent Smith",
  });
  runtimeConfig.dispose();
});

it.each(["Connection", "Access"])("does not dispatch after %s changes", async (changed) => {
  const request = vi.fn();
  const client = createTestGatewayClient(request);
  const state = host({ name: "Agent Smith" });
  await saveWithMutation(
    state,
    async (task, options) => {
      if (changed === "Access") {
        expect(options?.canDispatch?.()).toBe(false);
        return {
          ok: false,
          reason: "unavailable",
          error: options?.dispatchError ?? "Access changed.",
        };
      }
      try {
        return { ok: true, value: await task(client), refresh: { ok: true } };
      } catch (error) {
        return { ok: false, reason: "error", error: String(error) };
      }
    },
    {
      expectedClient: changed === "Connection" ? createTestGatewayClient(vi.fn()) : client,
      canDispatch: () => changed !== "Access",
    },
  );

  expect(request).not.toHaveBeenCalled();
  expect(state.identityError).toContain(
    `${changed} changed before the agent identity update started.`,
  );
});

it("clears a committed identity draft while surfacing a config refresh warning", async () => {
  const state = host({ name: "Agent Smith" });
  const runExternalMutation = vi.fn(async () => ({
    ok: true as const,
    value: {},
    refresh: { ok: false as const, error: "config.get failed after identity commit" },
  }));

  await saveWithMutation(state, runExternalMutation);
  expect(runExternalMutation).toHaveBeenCalledOnce();
  expect(state.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
  expect(state.identityError).toContain("config.get failed after identity commit");
});

it("preserves edits made while an autosave is in flight", async () => {
  const state = host({ name: "First name" });
  const pending = createDeferred();
  const runExternalMutation = vi.fn(async () => {
    await pending.promise;
    return { ok: true as const, value: {}, refresh: { ok: true as const } };
  });
  const saving = saveWithMutation(state, runExternalMutation);
  setIdentityDraftField(state, "name", "Second name");
  pending.resolve();
  await saving;

  expect(state).toMatchObject({ identityDraft: { name: "Second name" }, identitySaving: false });
});
