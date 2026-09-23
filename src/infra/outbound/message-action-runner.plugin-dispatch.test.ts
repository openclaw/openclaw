// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  readRecordField,
  expectRecordFields,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";
import type { MessageSendResult } from "./message.js";
import { resetDirectoryCache } from "./target-resolver.js";

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = useActionHubPluginFixture();

    it("uses the selected operation-local plugin for target resolution", async () => {
      const resolveTarget = vi.fn(async ({ input }: { input: string }) => ({
        to: `user:${input}`,
        kind: "user" as const,
      }));
      const handleScopedAction = vi.fn(async () => jsonResult({ ok: true }));
      const scopedPlugin = createGatewayActionPlugin({
        pluginId: "operation-local",
        label: "Operation Local",
        blurb: "Operation-local target resolution test plugin.",
        actions: ["react"],
        gatewayActions: [],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
            resolveTarget,
          },
        },
        handleAction: handleScopedAction,
      });

      setActivePluginRegistry(createTestRegistry([]));
      mocks.resolveOutboundChannelPlugin.mockReturnValue(scopedPlugin);
      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("operation-local"),
        action: "react",
        params: {
          channel: "operation-local",
          target: "plugin-alias",
          messageId: "message-1",
          emoji: "eyes",
        },
        dryRun: true,
      });

      expect(result).toMatchObject({ kind: "action", action: "react", handledBy: "dry-run" });
      expect(resolveTarget).toHaveBeenCalledWith(
        expect.objectContaining({ input: "plugin-alias", normalized: "plugin-alias" }),
      );
      expect(handleScopedAction).not.toHaveBeenCalled();
    });

    it("uses the selected operation-local plugin for broadcast target resolution", async () => {
      const resolveTarget = vi.fn(async ({ input }: { input: string }) => ({
        to: `user:${input}`,
        kind: "user" as const,
      }));
      const handleScopedAction = vi.fn(async () => jsonResult({ ok: true }));
      const scopedPlugin = createGatewayActionPlugin({
        pluginId: "operation-local",
        label: "Operation Local",
        blurb: "Operation-local broadcast target resolution test plugin.",
        actions: ["send"],
        gatewayActions: [],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
            resolveTarget,
          },
        },
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
      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("operation-local"),
        action: "broadcast",
        params: {
          channel: "operation-local",
          targets: ["plugin-alias"],
          message: "hello",
        },
        dryRun: true,
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        action: "broadcast",
        payload: {
          results: [{ channel: "operation-local", to: "user:plugin-alias", ok: true }],
        },
      });
      expect(resolveTarget).toHaveBeenCalledWith(
        expect.objectContaining({ input: "plugin-alias", normalized: "plugin-alias" }),
      );
      expect(handleScopedAction).not.toHaveBeenCalled();
    });

    it("rejects unsupported read actions before conversation authorization", async () => {
      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("actionhub"),
          action: "react",
          params: {
            channel: "actionhub",
            target: "other-conversation",
            messageId: "om_123",
            emoji: "eyes",
          },
          conversationReadOrigin: "delegated",
          dryRun: false,
        }),
      ).rejects.toThrow("Message action react not supported for channel actionhub.");
      expect(handleAction).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "rejects an external exact-current alias with the wrong account before target resolution (dryRun=%s)",
      async (dryRun) => {
        const looksLikeId = vi.fn(() => true);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "actionhub",
              source: "test",
              origin: "config",
              plugin: {
                ...actionHubPlugin,
                messaging: {
                  ...actionHubPlugin.messaging,
                  targetResolver: {
                    looksLikeId,
                  },
                },
              },
            },
          ]),
        );

        await expect(
          runMessageAction({
            cfg: createEnabledMessageActionConfig("actionhub"),
            action: "pin",
            params: {
              channel: "actionhub",
              target: "room:current",
              messageId: "om_123",
            },
            defaultAccountId: "other",
            requesterAccountId: "default",
            conversationReadOrigin: "delegated",
            toolContext: {
              currentChannelId: "actionhub:current",
              currentChannelProvider: "actionhub",
              currentChatType: "group",
            },
            dryRun,
          }),
        ).rejects.toThrow("requires the exact current conversation and account");
        expect(looksLikeId).not.toHaveBeenCalled();
        expect(handleAction).not.toHaveBeenCalled();
      },
    );

    it("rejects directory-only external aliases before resolver or plugin code", async () => {
      const looksLikeId = vi.fn(() => false);
      const resolveTarget = vi.fn(async () => ({
        to: "actionhub:current",
        kind: "group" as const,
      }));
      const listGroups = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      const listGroupsLive = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            origin: "config",
            plugin: {
              ...actionHubPlugin,
              messaging: {
                ...actionHubPlugin.messaging,
                targetResolver: { looksLikeId, resolveTarget },
              },
              directory: { listGroups, listGroupsLive },
            },
          },
        ]),
      );

      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("actionhub"),
          action: "pin",
          params: {
            channel: "actionhub",
            target: "current-room",
            messageId: "om_123",
          },
          defaultAccountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "actionhub:current",
            currentChannelProvider: "actionhub",
            currentChatType: "group",
          },
          dryRun: false,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");

      expect(looksLikeId).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(listGroups).not.toHaveBeenCalled();
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects unauthorized gateway-mode dry runs without resolving a target", async () => {
      const looksLikeId = vi.fn(() => true);
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat dry-run authorization test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            origin: "config",
            plugin: gatewayPlugin,
          },
        ]),
      );

      await expect(
        runMessageAction({
          cfg: createEnabledMessageActionConfig("gatewaychat"),
          action: "react",
          params: {
            channel: "gatewaychat",
            target: "room:current",
            messageId: "message-1",
            emoji: "eyes",
          },
          defaultAccountId: "other",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "gatewaychat:current",
            currentChannelProvider: "gatewaychat",
            currentChatType: "group",
          },
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: true,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(looksLikeId).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("preserves gateway send receipts in broadcast results", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-broadcast-1",
      });

      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: true,
              payload: {
                ok: true,
                messageId: "gw-broadcast-1",
              },
            },
          ],
        },
      });
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      delivery: Partial<MessageSendResult>;
      outcome: { ok: boolean; error?: string; sentBeforeError?: true };
    }>([
      {
        name: "sent",
        delivery: { deliveryStatus: "sent" },
        outcome: { ok: true },
      },
      {
        name: "suppressed",
        delivery: {
          deliveryStatus: "suppressed",
          suppressionReason: "cancelled_by_message_sending_hook",
        },
        outcome: {
          ok: false,
          error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
        },
      },
      {
        name: "failed",
        delivery: {
          deliveryStatus: "failed",
          error: "provider rejected the message",
        },
        outcome: { ok: false, error: "provider rejected the message" },
      },
      {
        name: "failed without an error",
        delivery: { deliveryStatus: "failed" },
        outcome: { ok: false, error: "Broadcast send failed." },
      },
      {
        name: "partial_failed",
        delivery: {
          deliveryStatus: "partial_failed",
          error: "second payload failed",
          sentBeforeError: true,
        },
        outcome: { ok: false, error: "second payload failed", sentBeforeError: true },
      },
      {
        name: "partial_failed without an error",
        delivery: { deliveryStatus: "partial_failed", sentBeforeError: true },
        outcome: {
          ok: false,
          error: "Broadcast send partially failed.",
          sentBeforeError: true,
        },
      },
      {
        name: "legacy result without deliveryStatus",
        delivery: {
          via: "gateway",
          result: { messageId: "legacy-message-1" },
        },
        outcome: { ok: true },
      },
    ])("derives broadcast truth from a $name send result", async ({ delivery, outcome }) => {
      const nestedPayload = { ok: true, nested: "payload" };
      const sendResult = {
        channel: "gatewaychat",
        to: "user-123",
        via: "direct",
        mediaUrl: null,
        ...delivery,
      } satisfies MessageSendResult;
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat delivery truth test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.executeSendAction.mockResolvedValue({
        handledBy: "core",
        payload: nestedPayload,
        sendResult,
      });

      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
      });

      expect(result.kind).toBe("broadcast");
      if (result.kind !== "broadcast") {
        throw new Error("expected broadcast result");
      }
      expect(result.payload.results).toEqual([
        {
          channel: "gatewaychat",
          to: "user-123",
          ...outcome,
          payload: nestedPayload,
          result: sendResult,
        },
      ]);
      expect(result.payload.results[0]?.payload).toBe(nestedPayload);
      expect(result.payload.results[0]?.result).toBe(sendResult);
    });

    it("preserves partial-delivery evidence from failed broadcast sends", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat partial broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockRejectedValue(
        Object.assign(new Error("second payload failed"), { sentBeforeError: true }),
      );

      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: false,
              sentBeforeError: true,
              error: "second payload failed",
            },
          ],
        },
      });
    });
  });
  describe("ordinary target preparation currentness", () => {
    const channel = "directorychat";
    const cfg = createEnabledMessageActionConfig(channel);
    type Directory = NonNullable<ChannelPlugin["directory"]>;
    type TargetResolver = NonNullable<NonNullable<ChannelPlugin["messaging"]>["targetResolver"]>;
    const listPeers = vi.fn<NonNullable<Directory["listPeers"]>>();
    const listPeersLive = vi.fn<NonNullable<Directory["listPeersLive"]>>();
    const resolveTarget = vi.fn<NonNullable<TargetResolver["resolveTarget"]>>();
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, to: params.to }),
    );
    const basePlugin = createGatewayActionPlugin({
      pluginId: channel,
      label: "Directory Chat",
      blurb: "Directory-backed action test plugin.",
      actions: ["pin", "send"],
      gatewayActions: [],
      messaging: {
        targetResolver: {
          looksLikeId: (value) => value.startsWith("user:resolved-"),
          resolveTarget,
        },
      },
      handleAction,
    });
    const plugin: ChannelPlugin = {
      ...basePlugin,
      directory: { listPeers, listPeersLive },
      actions: { ...basePlugin.actions, providerOwnedReadGates: ["pin"] },
    };
    const entry = (name: string) => ({
      kind: "user" as const,
      id: `user:resolved-${name}`,
      name,
    });
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
      setActivePluginRegistry(createTestRegistry([]));
    });

    describe.each(["pin", "broadcast"] as const)("%s", (action) => {
      it.each(["active", "caller", "signal"] as const)(
        "checks currentness after directory request preparation (%s)",
        async (retirement) => {
          const retired = retirement !== "active";
          const entered = createDeferred();
          const release = createDeferred();
          const caller = new AbortController();
          const canceled = new Error("caller retired during directory preparation");
          const requests: string[] = [];
          listPeersLive.mockImplementationOnce(async ({ query, accountId }) => {
            const assertCurrent = captureChannelReadAuthority();
            entered.resolve();
            await release.promise;
            assertCurrent?.();
            requests.push(`${accountId}:${query}`);
            return [entry("Alpha")];
          });

          const pending = runLookup(
            "Alpha",
            retirement === "signal" ? undefined : () => caller.signal.throwIfAborted(),
            action,
            retirement === "signal" ? caller.signal : undefined,
          ).catch((error: unknown) => error);
          await entered.promise;
          if (retired) {
            caller.abort(canceled);
          }
          release.resolve();
          const result = await pending;

          expect(requests).toEqual(retired ? [] : ["default:Alpha"]);
          expect(handleAction).toHaveBeenCalledTimes(
            (action === "broadcast" ? 1 : 0) + (retired ? 0 : 1),
          );
          if (action === "broadcast") {
            expect(result).toMatchObject({
              kind: "broadcast",
              payload: {
                results: [
                  { ok: true, to: "user:resolved-First" },
                  retired
                    ? { ok: false, to: "user:Alpha", attempted: false }
                    : { ok: true, to: "user:resolved-Alpha" },
                ],
              },
            });
          } else if (retired) {
            expect(result).toMatchObject({
              code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
              cause:
                retirement === "signal"
                  ? expect.objectContaining({ name: "AbortError" })
                  : canceled,
            });
          } else {
            expect(result).toMatchObject({
              kind: "action",
              payload: { ok: true, to: "user:resolved-Alpha" },
            });
          }
        },
      );
    });

    it("isolates a retired caller from concurrent directory preparation", async () => {
      const first = { entered: createDeferred(), release: createDeferred() };
      const second = { entered: createDeferred(), release: createDeferred() };
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

    it("keeps callback-free directory lookup and cached reuse working", async () => {
      listPeersLive.mockImplementationOnce(async () => {
        expect(captureChannelReadAuthority()).toBeUndefined();
        return [entry("Alpha")];
      });
      for (const assertCurrent of [undefined, () => {}]) {
        expect(await runLookup("Alpha", assertCurrent)).toMatchObject({
          kind: "action",
          payload: { ok: true, to: "user:resolved-Alpha" },
        });
      }
      expect(listPeers).toHaveBeenCalledOnce();
      expect(listPeersLive).toHaveBeenCalledOnce();
      expect(handleAction).toHaveBeenCalledTimes(2);
    });

    describe.each(["cached directory", "live directory"] as const)("%s miss", (stage) => {
      it.each([false, true])(
        "checks the caller before the next lookup (retired=%s)",
        async (retired) => {
          const entered = createDeferred();
          const release = createDeferred();
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
          if (retired) {
            caller.abort(canceled);
          }
          release.resolve();
          const result = await pending;

          expect(nextLookup).toHaveBeenCalledTimes(retired ? 0 : 1);
          expect(handleAction).toHaveBeenCalledTimes(retired ? 0 : 1);
          if (retired) {
            expect(result).toMatchObject({
              code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
              cause: canceled,
            });
          } else {
            expect(result).toMatchObject({
              kind: "action",
              payload: { ok: true, to: "user:resolved-Alpha" },
            });
          }
        },
      );
    });
  });
  describe("presentation parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        presentation: params.presentation ?? null,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      id: "componentchat",
      meta: {
        id: "componentchat",
        label: "Component Chat",
        selectionLabel: "Component Chat",
        docsPath: "/channels/componentchat",
        blurb: "Component chat send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(componentsPlugin, "componentchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses presentation JSON strings before plugin dispatch", async () => {
      const presentation = {
        blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }],
      };
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "componentchat",
          target: "channel:123",
          message: "hi",
          presentation: JSON.stringify(presentation),
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          presentation,
        },
        "result payload",
      );
    });

    it("throws on invalid presentation JSON strings", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "componentchat",
            target: "channel:123",
            message: "hi",
            presentation: "{not-json}",
          },
          dryRun: false,
        }),
      ).rejects.toThrow(/--presentation must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });
  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const listGroupsLive = vi.fn(async () => [
      { id: "channel:resolved", name: "resolved", kind: "group" as const },
    ]);
    const accountPlugin: ChannelPlugin = {
      id: "accountchat",
      meta: {
        id: "accountchat",
        label: "Account Chat",
        selectionLabel: "Account Chat",
        docsPath: "/channels/accountchat",
        blurb: "Account chat test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default", "ops", "disabled"],
        resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
      },
      directory: { listGroupsLive },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(accountPlugin, "accountchat");
      handleAction.mockClear();
      listGroupsLive.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("rejects an unknown broadcast account before live target resolution", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "accountchat",
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [{ ok: false, error: expect.stringContaining("Unknown account") }],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("preserves planned per-channel broadcast rejection without resolving a target", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
        broadcastAccountPlan: {
          accountId: "missing",
          candidateChannels: ["accountchat"],
          secretChannels: [],
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "accountchat",
              ok: false,
              error: expect.stringContaining("Unknown account"),
            },
          ],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects an empty broadcast account plan instead of reporting empty success", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "broadcast",
          params: {
            targets: ["resolved"],
            accountId: "missing",
            message: "hi",
          },
          broadcastAccountPlan: {
            accountId: "missing",
            candidateChannels: [],
            secretChannels: [],
          },
        }),
      ).rejects.toThrow("Broadcast requires at least one configured channel");

      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });
  });
});
