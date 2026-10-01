import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureChannelReadAuthority } from "../../shared/channel-read-authority.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  resetMessageActionMediaMocks,
  createWorkspaceMediaTestPlugin,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";
import { workspaceConfig } from "./message-action-runner.test-support.js";
import type { MessageSendResult } from "./message.js";
import { resetDirectoryCache } from "./target-resolver.js";

type ActionInput = Parameters<typeof runMessageAction>[0];
type ActionResult = Awaited<ReturnType<typeof runMessageAction>>;
type PluginOptions = Parameters<typeof createGatewayActionPlugin>[0];
type TargetResolver = NonNullable<NonNullable<ChannelPlugin["messaging"]>["targetResolver"]>;

function createActionPlugin(
  pluginId: string,
  options: Omit<PluginOptions, "pluginId" | "label" | "blurb">,
) {
  return createGatewayActionPlugin({
    pluginId,
    label: pluginId,
    blurb: "Action fixture.",
    ...options,
  });
}

function registerExternalPlugin(plugin: ChannelPlugin) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: plugin.id, source: "test", origin: "config", plugin }]),
  );
}

function runDelegated(
  channel: string,
  action: ActionInput["action"],
  params: Record<string, unknown>,
  options: Partial<ActionInput> = {},
) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig(channel),
    action,
    params: { channel, ...params },
    defaultAccountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelId: `${channel}:current`,
      currentChannelProvider: channel,
      currentChatType: "group",
    },
    dryRun: false,
    ...options,
  });
}

function runBroadcast(channel: string, target = "user-123", options: Partial<ActionInput> = {}) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig(channel),
    action: "broadcast",
    params: { channel, targets: [target], message: "hello from broadcast" },
    ...options,
  });
}

function registerGatewaySender() {
  setTestPlugin(
    createActionPlugin("gatewaychat", {
      actions: ["send"],
      messaging: { targetResolver: { looksLikeId: () => true } },
      handleAction: vi.fn(async () => jsonResult({ ok: true })),
    }),
    "gatewaychat",
  );
}

function createLookupGate() {
  return { entered: createDeferred(), release: createDeferred() };
}

function expectBroadcastRows(result: ActionResult, results: Array<Record<string, unknown>>) {
  expect(result).toMatchObject({ kind: "broadcast", payload: { results } });
}

function expectUncalled(...spies: Array<{ mock: { calls: readonly unknown[][] } }>) {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(resetMessageActionRunnerMocks);
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = useActionHubPluginFixture();
    const accountError = "requires the exact current conversation and account";
    const registerActionHubResolver = (
      targetResolver: TargetResolver,
      directory?: ChannelPlugin["directory"],
    ) =>
      registerExternalPlugin({
        ...actionHubPlugin,
        messaging: { ...actionHubPlugin.messaging, targetResolver },
        ...(directory ? { directory } : {}),
      });

    it.each([
      { action: "thread-create" as const, dryRun: false, blocked: true },
      { action: "channel-info" as const, dryRun: false, blocked: false },
      { action: "thread-create" as const, dryRun: true, blocked: false },
    ])(
      "fences writes while permitting authorized reads and dry runs ($action, dryRun=$dryRun)",
      async ({ action, dryRun, blocked }) => {
        const beforeDeliveryAttempt = vi.fn(async () => {
          throw new Error("occurrence delivery fence unavailable");
        });
        const pending = runMessageAction({
          cfg: createEnabledMessageActionConfig("actionhub"),
          action,
          params: { channel: "actionhub", target: "actionhub:current", name: "report" },
          dryRun,
          defaultAccountId: "default",
          messageActionAuthorization: {
            requesterAccountId: "default",
            toolContext: {
              currentChannelId: "channel:current",
              currentChannelProvider: "actionhub",
              currentChatType: "channel",
            },
            deliveryAttempt: { beforeAttempt: beforeDeliveryAttempt, assertCurrent: () => {} },
            scheduled: { policy: { version: 1, mode: "trusted" }, assertCurrent: () => {} },
          },
        });
        if (blocked) {
          await expect(pending).rejects.toThrow("occurrence delivery fence unavailable");
          expect(beforeDeliveryAttempt).toHaveBeenCalledOnce();
          expect(handleAction).not.toHaveBeenCalled();
        } else {
          await expect(pending).resolves.toMatchObject({ dryRun });
          expect(beforeDeliveryAttempt).not.toHaveBeenCalled();
          expect(handleAction).toHaveBeenCalledTimes(dryRun ? 0 : 1);
        }
      },
    );

    it("resolves broadcasts with the operation-local plugin", async () => {
      const resolveTarget = vi.fn(async ({ input }: { input: string }) => ({
        to: `user:${input}`,
        kind: "user" as const,
      }));
      const handleScopedAction = vi.fn(async () => jsonResult({ ok: true }));
      const scopedPlugin = createActionPlugin("operation-local", {
        actions: ["send"],
        gatewayActions: [],
        messaging: { targetResolver: { looksLikeId: () => true, resolveTarget } },
        handleAction: handleScopedAction,
      });
      setActivePluginRegistry(createTestRegistry([]));
      mocks.resolveOutboundChannelPlugin.mockReturnValue(scopedPlugin);
      mocks.executeSendAction.mockResolvedValue({
        handledBy: "core",
        payload: { ok: true },
        sendResult: {
          channel: "operation-local",
          to: "user:plugin-alias",
          via: "direct",
          mediaUrl: null,
        },
      });
      const result = await runBroadcast("operation-local", "plugin-alias", { dryRun: true });
      expectBroadcastRows(result, [
        { channel: "operation-local", to: "user:plugin-alias", ok: true },
      ]);
      expect(resolveTarget).toHaveBeenCalledWith(
        expect.objectContaining({ input: "plugin-alias", normalized: "plugin-alias" }),
      );
      expect(handleScopedAction).not.toHaveBeenCalled();
    });

    it("rejects unsupported uploads before authorization and media I/O", async () => {
      mocks.loadWebMedia.mockRejectedValue(new Error("media must not load"));
      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("actionhub"),
          action: "upload-file",
          params: {
            channel: "actionhub",
            target: "other-conversation",
            media: "https://example.com/pic.png",
          },
          conversationReadOrigin: "delegated",
          dryRun: false,
        }),
      ).rejects.toThrow("Message action upload-file not supported for channel actionhub.");
      expectUncalled(handleAction, mocks.loadWebMedia);
    });

    it("rejects wrong-account aliases before resolution", async () => {
      const looksLikeId = vi.fn(() => true);
      registerActionHubResolver({ looksLikeId });
      await expect(
        runDelegated(
          "actionhub",
          "pin",
          { target: "room:current", messageId: "om_123" },
          { defaultAccountId: "other" },
        ),
      ).rejects.toThrow(accountError);
      expectUncalled(looksLikeId, handleAction);
    });

    it("rejects directory-only external aliases before lookup", async () => {
      const looksLikeId = vi.fn(() => false);
      const resolveTarget = vi.fn(async () => ({
        to: "actionhub:current",
        kind: "group" as const,
      }));
      const entries = [{ kind: "group" as const, id: "actionhub:current", name: "current-room" }];
      const listGroups = vi.fn(async () => entries);
      const listGroupsLive = vi.fn(async () => entries);
      registerActionHubResolver({ looksLikeId, resolveTarget }, { listGroups, listGroupsLive });
      await expect(
        runDelegated("actionhub", "pin", { target: "current-room", messageId: "om_123" }),
      ).rejects.toThrow(accountError);
      expectUncalled(looksLikeId, resolveTarget, listGroups, listGroupsLive, handleAction);
    });

    it("authorizes Gateway dry runs before target lookup", async () => {
      const looksLikeId = vi.fn(() => true);
      registerExternalPlugin(
        createActionPlugin("gatewaychat", {
          actions: ["react"],
          capabilities: { chatTypes: ["direct"], reactions: true },
          messaging: { targetResolver: { looksLikeId } },
          handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
        }),
      );
      await expect(
        runDelegated(
          "gatewaychat",
          "react",
          { target: "room:current", messageId: "message-1", emoji: "eyes" },
          {
            defaultAccountId: "other",
            dryRun: true,
            gateway: {
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
            },
          },
        ),
      ).rejects.toThrow(accountError);
      expectUncalled(looksLikeId, mocks.callGatewayLeastPrivilege);
    });

    it("preserves suppressed send outcomes and their payloads", async () => {
      const nestedPayload = { ok: true, nested: "payload" };
      const sendResult = {
        channel: "gatewaychat",
        to: "user-123",
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "suppressed",
        suppressionReason: "cancelled_by_message_sending_hook",
      } satisfies MessageSendResult;
      registerGatewaySender();
      mocks.executeSendAction.mockResolvedValue({
        handledBy: "core",
        payload: nestedPayload,
        sendResult,
      });
      const result = await runBroadcast("gatewaychat");
      if (result.kind !== "broadcast") {
        throw new Error("expected broadcast result");
      }
      expect(result.payload.results).toEqual([
        {
          channel: "gatewaychat",
          to: "user-123",
          ok: false,
          error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
          payload: nestedPayload,
          result: sendResult,
        },
      ]);
      expect(result.payload.results[0]?.payload).toBe(nestedPayload);
      expect(result.payload.results[0]?.result).toBe(sendResult);
    });

    it("retains partial delivery from Gateway errors", async () => {
      registerGatewaySender();
      mocks.callGatewayLeastPrivilege.mockRejectedValue(
        Object.assign(new Error("second payload failed"), { sentBeforeError: true }),
      );
      const result = await runBroadcast("gatewaychat", "user-123", {
        gateway: { clientName: "cli", mode: "cli" },
      });
      expectBroadcastRows(result, [
        {
          channel: "gatewaychat",
          to: "user-123",
          ok: false,
          sentBeforeError: true,
          error: "second payload failed",
        },
      ]);
    });
  });

  describe("ordinary target preparation currentness", () => {
    const channel = "directorychat";
    const cfg = createEnabledMessageActionConfig(channel);
    type Directory = NonNullable<ChannelPlugin["directory"]>;
    const listPeers = vi.fn<NonNullable<Directory["listPeers"]>>();
    const listPeersLive = vi.fn<NonNullable<Directory["listPeersLive"]>>();
    const resolveTarget = vi.fn<NonNullable<TargetResolver["resolveTarget"]>>();
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, to: params.to }),
    );
    const basePlugin = createActionPlugin(channel, {
      actions: ["pin", "send"],
      gatewayActions: [],
      handleAction,
      messaging: {
        targetResolver: {
          looksLikeId: (value) => value.startsWith("user:resolved-"),
          resolveTarget,
        },
      },
    });
    const plugin: ChannelPlugin = {
      ...basePlugin,
      directory: { listPeers, listPeersLive },
      actions: { ...basePlugin.actions, providerOwnedReadGates: ["pin"] },
    };
    const entry = (name: string) => ({ kind: "user" as const, id: `user:resolved-${name}`, name });
    const runLookup = (
      name: string,
      assertCurrent?: () => void,
      action: "pin" | "broadcast" = "pin",
      abortSignal?: AbortSignal,
    ) =>
      runMessageAction({
        cfg,
        action,
        params: {
          channel,
          accountId: "default",
          ...(action === "broadcast"
            ? { targets: ["user:resolved-First", `user:${name}`], message: "hello" }
            : { target: `user:${name}`, messageId: "message-1" }),
        },
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: channel,
          currentChannelId: `user:resolved-${name}`,
          currentChatType: "direct",
        },
        assertDirectAdapterHandoff: assertCurrent,
        abortSignal,
      });
    beforeEach(() => {
      listPeers.mockReset().mockResolvedValue([]);
      listPeersLive.mockReset().mockResolvedValue([entry("Alpha")]);
      resolveTarget.mockReset().mockImplementation(async ({ input }) => ({
        to: input.startsWith("user:resolved-")
          ? input
          : `user:resolved-${input.replace(/^user:/, "")}`,
        kind: "user",
      }));
      handleAction.mockClear();
      resetDirectoryCache();
      setTestPlugin(plugin, channel, "bundled");
    });
    afterEach(() => {
      resetDirectoryCache();
    });

    it("stops broadcast directory preparation when its signal is canceled", async () => {
      const { entered, release } = createLookupGate();
      const caller = new AbortController();
      const requests: string[] = [];
      listPeersLive.mockImplementationOnce(async ({ query, accountId }) => {
        const assertCurrent = captureChannelReadAuthority();
        entered.resolve();
        await release.promise;
        assertCurrent?.();
        requests.push(`${accountId}:${query}`);
        return [entry("Alpha")];
      });
      const pending = runLookup("Alpha", undefined, "broadcast", caller.signal);
      await entered.promise;
      caller.abort(new Error("caller retired during directory preparation"));
      release.resolve();
      expectBroadcastRows(await pending, [
        { ok: true, to: "user:resolved-First" },
        { ok: false, to: "user:Alpha", attempted: false },
      ]);
      expect(requests).toEqual([]);
      expect(handleAction).toHaveBeenCalledOnce();
    });

    it("isolates a retired caller from concurrent directory preparation", async () => {
      const first = createLookupGate();
      const second = createLookupGate();
      const caller = new AbortController();
      const canceled = new Error("first caller retired");
      const requests: string[] = [];
      listPeersLive.mockImplementation(async ({ query }) => {
        const assertCurrent = captureChannelReadAuthority();
        const gate = query === "Alpha" ? first : second;
        gate.entered.resolve();
        await gate.release.promise;
        assertCurrent?.();
        requests.push(query ?? "");
        return [entry(query ?? "")];
      });
      const retired = runLookup("Alpha", () => caller.signal.throwIfAborted()).catch(
        (error: unknown) => error,
      );
      await first.entered.promise;
      const active = runLookup("Beta", () => {});
      await second.entered.promise;
      caller.abort(canceled);
      first.release.resolve();
      second.release.resolve();
      const retiredResult = await retired;
      expect(requests).toEqual(["Beta"]);
      expect(retiredResult).toMatchObject({
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        cause: canceled,
      });
      expect(await active).toMatchObject({
        kind: "action",
        payload: { ok: true, to: "user:resolved-Beta" },
      });
      expect(handleAction).toHaveBeenCalledOnce();
    });

    it.each(["cached directory", "live directory"] as const)(
      "checks the caller after a %s miss before the next lookup",
      async (stage) => {
        const { entered, release } = createLookupGate();
        const caller = new AbortController();
        const canceled = new Error("caller retired during directory miss");
        const heldLookup = stage === "cached directory" ? listPeers : listPeersLive;
        const nextLookup = stage === "cached directory" ? listPeersLive : resolveTarget;
        heldLookup.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return [];
        });
        const pending = runLookup("Alpha", () => caller.signal.throwIfAborted()).catch(
          (error: unknown) => error,
        );
        await entered.promise;
        caller.abort(canceled);
        release.resolve();
        expect(await pending).toMatchObject({
          code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
          cause: canceled,
        });
        expectUncalled(nextLookup, handleAction);
      },
    );
  });

  describe("presentation parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, presentation: params.presentation ?? null }),
    );
    const componentsPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "componentchat",
        label: "Component Chat",
        config: createAlwaysConfiguredPluginConfig({}),
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };
    const sendPresentation = (presentation: string) =>
      runMessageAction({
        cfg: {},
        action: "send",
        dryRun: false,
        params: { channel: "componentchat", target: "channel:123", message: "hi", presentation },
      });
    beforeEach(() => {
      setTestPlugin(componentsPlugin, "componentchat");
      handleAction.mockClear();
    });

    it.each([true, false])("validates presentation JSON (valid=%s)", async (valid) => {
      const presentation = { blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }] };
      const pending = sendPresentation(valid ? JSON.stringify(presentation) : "{not-json}");
      if (valid) {
        const result = await pending;
        expect(result.payload).toEqual(expect.objectContaining({ ok: true, presentation }));
      } else {
        await expect(pending).rejects.toThrow(/--presentation must be valid JSON/);
        expect(handleAction).not.toHaveBeenCalled();
      }
    });
  });

  it.each([{ candidateChannels: ["accountchat"] }, { candidateChannels: [] }])(
    "rejects invalid broadcast account plans (%j)",
    async ({ candidateChannels }) => {
      const handleAction = vi.fn(async () => jsonResult({ ok: true }));
      const listGroupsLive = vi.fn(async () => [
        { id: "channel:resolved", name: "resolved", kind: "group" as const },
      ]);
      setTestPlugin(
        {
          ...createChannelTestPluginBase({
            id: "accountchat",
            config: {
              listAccountIds: () => ["default", "ops", "disabled"],
              resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
            },
          }),
          directory: { listGroupsLive },
          actions: { describeMessageTool: () => ({ actions: ["send"] }), handleAction },
        },
        "accountchat",
      );
      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: { targets: ["resolved"], accountId: "missing", message: "hi" },
        broadcastAccountPlan: { accountId: "missing", candidateChannels, secretChannels: [] },
      });
      if (candidateChannels.length) {
        expectBroadcastRows(await pending, [
          { channel: "accountchat", ok: false, error: expect.stringContaining("Unknown account") },
        ]);
      } else {
        await expect(pending).rejects.toThrow("Broadcast requires at least one configured channel");
      }
      expectUncalled(listGroupsLive, handleAction);
    },
  );

  describe("media preparation", () => {
    const workspacePlugin = createWorkspaceMediaTestPlugin();
    beforeEach(resetMessageActionMediaMocks);
    it("validates targets before staging send buffers", async () => {
      setTestPlugin(workspacePlugin, "workspace");

      await withOpenClawTestState(
        { layout: "state-only", prefix: "msg-runner-state-" },
        async ({ stateDir }) => {
          await expect(
            runMessageAction({
              cfg: workspaceConfig,
              action: "send",
              params: {
                channel: "workspace",
                target: "",
                buffer: Buffer.from("orphan bytes").toString("base64"),
                filename: "orphan.txt",
                contentType: "text/plain",
              },
            }),
          ).rejects.toThrow(/target/i);

          expect(mocks.executeSendAction).not.toHaveBeenCalled();
          await expect(fs.readdir(path.join(stateDir, "media", "outbound"))).rejects.toThrow();
        },
      );
    });

    it("keeps sandbox attachments off the host reader", async () => {
      const handleAction = vi.fn(async () => jsonResult({ ok: true }));
      const uploadPlugin: ChannelPlugin = {
        ...workspacePlugin,
        messaging: {
          normalizeTarget: (raw) => raw.trim() || undefined,
          targetResolver: { looksLikeId: (raw) => raw.trim().length > 0 },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["upload-file"] }),
          supportsAction: ({ action }) => action === "upload-file",
          handleAction,
        },
      };
      setTestPlugin(uploadPlugin, "workspace");
      const hostReadFile = vi.fn(async () => Buffer.from("host workspace"));
      vi.mocked(mocks.loadWebMedia).mockImplementation(async (_mediaUrl, maxBytesOrOptions) => {
        const options =
          typeof maxBytesOrOptions === "object" && maxBytesOrOptions !== null
            ? maxBytesOrOptions
            : undefined;
        expect(options?.readFile).not.toBe(hostReadFile);
        return {
          buffer: Buffer.from("sandbox mirror"),
          contentType: "text/plain",
          fileName: "chart.txt",
          kind: "document",
        };
      });

      await runMessageAction({
        cfg: workspaceConfig,
        action: "upload-file",
        params: {
          channel: "workspace",
          target: "room-1",
          media: "/sandbox/chart.txt",
        },
        sandboxRoot: "/host-mirror",
        sandboxContainerWorkdir: "/sandbox",
        mediaAccess: { localRoots: ["/host-mirror"], readFile: hostReadFile },
      });

      expect(mocks.loadWebMedia).toHaveBeenCalled();
      expect(hostReadFile).not.toHaveBeenCalled();
      expect(handleAction).toHaveBeenCalled();
    });
  });
});
