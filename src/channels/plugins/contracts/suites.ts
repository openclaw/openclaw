import { expect, it, type Mock } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ChannelMessageCapability } from "../message-capabilities.js";
import type {
  ResolveProviderRuntimeGroupPolicyParams,
  RuntimeGroupPolicyResolution,
} from "../../../config/runtime-group-policy.js";
import { normalizeChatType } from "../../chat-type.js";
import { resolveConversationLabel } from "../../conversation-label.js";
import { validateSenderIdentity } from "../../sender-identity.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelSetupInput,
} from "../types.core.js";
import type {
  ChannelMessageActionName,
  ChannelMessageCapability,
  ChannelPlugin,
} from "../types.js";

function sortStrings(values: readonly string[]) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

export function installChannelPluginContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
}) {
  it("satisfies the base channel plugin contract", () => {
    const { plugin } = params;

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim()).not.toBe("");

    expect(plugin.meta.id).toBe(plugin.id);
    expect(plugin.meta.label.trim()).not.toBe("");
    expect(plugin.meta.selectionLabel.trim()).not.toBe("");
    expect(plugin.meta.docsPath).toMatch(/^\/channels\//);
    expect(plugin.meta.blurb.trim()).not.toBe("");

    expect(plugin.capabilities.chatTypes.length).toBeGreaterThan(0);

    expect(typeof plugin.config.listAccountIds).toBe("function");
    expect(typeof plugin.config.resolveAccount).toBe("function");
  });
}

type ChannelActionsContractCase = {
  name: string;
  cfg: OpenClawConfig;
  expectedActions: readonly ChannelMessageActionName[];
  expectedCapabilities?: readonly ChannelMessageCapability[];
  beforeTest?: () => void;
};

export function installChannelActionsContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "actions">;
  cases: readonly ChannelActionsContractCase[];
  unsupportedAction?: ChannelMessageActionName;
}) {
  it("exposes the base message actions contract", () => {
    expect(params.plugin.actions).toBeDefined();
    expect(typeof params.plugin.actions?.listActions).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`actions contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const actions = params.plugin.actions?.listActions?.({ cfg: testCase.cfg }) ?? [];
      const capabilities = params.plugin.actions?.getCapabilities?.({ cfg: testCase.cfg }) ?? [];

      expect(actions).toEqual([...new Set(actions)]);
      expect(capabilities).toEqual([...new Set(capabilities)]);
      expect(sortStrings(actions)).toEqual(sortStrings(testCase.expectedActions));
      expect(sortStrings(capabilities)).toEqual(sortStrings(testCase.expectedCapabilities ?? []));

      if (params.plugin.actions?.supportsAction) {
        for (const action of testCase.expectedActions) {
          expect(params.plugin.actions.supportsAction({ action })).toBe(true);
        }
        if (
          params.unsupportedAction &&
          !testCase.expectedActions.includes(params.unsupportedAction)
        ) {
          expect(params.plugin.actions.supportsAction({ action: params.unsupportedAction })).toBe(
            false,
          );
        }
      }
    });
  }
}

export function installChannelSurfaceContractSuite(params: {
  plugin: Pick<
    ChannelPlugin,
    | "id"
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway"
  >;
  surface:
    | "actions"
    | "setup"
    | "status"
    | "outbound"
    | "messaging"
    | "threading"
    | "directory"
    | "gateway";
}) {
  const { plugin, surface } = params;

  it(`exposes the ${surface} surface contract`, () => {
    if (surface === "actions") {
      expect(plugin.actions).toBeDefined();
      expect(typeof plugin.actions?.listActions).toBe("function");
      return;
    }

    if (surface === "setup") {
      expect(plugin.setup).toBeDefined();
      expect(typeof plugin.setup?.applyAccountConfig).toBe("function");
      return;
    }

    if (surface === "status") {
      expect(plugin.status).toBeDefined();
      expect(typeof plugin.status?.buildAccountSnapshot).toBe("function");
      return;
    }

    if (surface === "outbound") {
      const outbound = plugin.outbound;
      expect(outbound).toBeDefined();
      expect(["direct", "gateway", "hybrid"]).toContain(outbound?.deliveryMode);
      expect(
        [
          outbound?.sendPayload,
          outbound?.sendFormattedText,
          outbound?.sendFormattedMedia,
          outbound?.sendText,
          outbound?.sendMedia,
          outbound?.sendPoll,
        ].some((value) => typeof value === "function"),
      ).toBe(true);
      return;
    }

    if (surface === "messaging") {
      const messaging = plugin.messaging;
      expect(messaging).toBeDefined();
      expect(
        [
          messaging?.normalizeTarget,
          messaging?.parseExplicitTarget,
          messaging?.inferTargetChatType,
          messaging?.buildCrossContextComponents,
          messaging?.enableInteractiveReplies,
          messaging?.hasStructuredReplyPayload,
          messaging?.formatTargetDisplay,
          messaging?.resolveOutboundSessionRoute,
        ].some((value) => typeof value === "function"),
      ).toBe(true);
      if (messaging?.targetResolver) {
        if (messaging.targetResolver.looksLikeId) {
          expect(typeof messaging.targetResolver.looksLikeId).toBe("function");
        }
        if (messaging.targetResolver.hint !== undefined) {
          expect(typeof messaging.targetResolver.hint).toBe("string");
          expect(messaging.targetResolver.hint.trim()).not.toBe("");
        }
        if (messaging.targetResolver.resolveTarget) {
          expect(typeof messaging.targetResolver.resolveTarget).toBe("function");
        }
      }
      return;
    }

    if (surface === "threading") {
      const threading = plugin.threading;
      expect(threading).toBeDefined();
      expect(
        [
          threading?.resolveReplyToMode,
          threading?.buildToolContext,
          threading?.resolveAutoThreadId,
          threading?.resolveReplyTransport,
          threading?.resolveFocusedBinding,
        ].some((value) => typeof value === "function"),
      ).toBe(true);
      return;
    }

    if (surface === "directory") {
      const directory = plugin.directory;
      expect(directory).toBeDefined();
      expect(
        [
          directory?.self,
          directory?.listPeers,
          directory?.listPeersLive,
          directory?.listGroups,
          directory?.listGroupsLive,
          directory?.listGroupMembers,
        ].some((value) => typeof value === "function"),
      ).toBe(true);
      return;
    }

    const gateway = plugin.gateway;
    expect(gateway).toBeDefined();
    expect(
      [
        gateway?.startAccount,
        gateway?.stopAccount,
        gateway?.loginWithQrStart,
        gateway?.loginWithQrWait,
        gateway?.logoutAccount,
      ].some((value) => typeof value === "function"),
    ).toBe(true);
  });
}

type ChannelSetupContractCase<ResolvedAccount> = {
  name: string;
  cfg: OpenClawConfig;
  accountId?: string;
  input: ChannelSetupInput;
  expectedAccountId?: string;
  expectedValidation?: string | null;
  beforeTest?: () => void;
  assertPatchedConfig?: (cfg: OpenClawConfig) => void;
  assertResolvedAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => void;
};

export function installChannelSetupContractSuite<ResolvedAccount>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount>, "id" | "config" | "setup">;
  cases: readonly ChannelSetupContractCase<ResolvedAccount>[];
}) {
  it("exposes the base setup contract", () => {
    expect(params.plugin.setup).toBeDefined();
    expect(typeof params.plugin.setup?.applyAccountConfig).toBe("function");
  });

  for (const testCase of params.cases) {
    it(`setup contract: ${testCase.name}`, () => {
      testCase.beforeTest?.();

      const resolvedAccountId =
        params.plugin.setup?.resolveAccountId?.({
          cfg: testCase.cfg,
          accountId: testCase.accountId,
          input: testCase.input,
        }) ??
        testCase.accountId ??
        "default";

      expect(resolvedAccountId).toBe(testCase.expectedAccountId ?? resolvedAccountId);

      const validation =
        params.plugin.setup?.validateInput?.({
          cfg: testCase.cfg,
          accountId: resolvedAccountId,
          input: testCase.input,
        }) ?? null;
      expect(validation).toBe(testCase.expectedValidation ?? null);

      const nextCfg = params.plugin.setup?.applyAccountConfig({
        cfg: testCase.cfg,
        accountId: resolvedAccountId,
        input: testCase.input,
      });
      expect(nextCfg).toBeDefined();

      const account = params.plugin.config.resolveAccount(nextCfg!, resolvedAccountId);
      testCase.assertPatchedConfig?.(nextCfg!);
      testCase.assertResolvedAccount?.(account, nextCfg!);
    });
  }
}

type ChannelStatusContractCase<Probe> = {
  name: string;
  cfg: OpenClawConfig;
  accountId?: string;
  runtime?: ChannelAccountSnapshot;
  probe?: Probe;
  beforeTest?: () => void;
  expectedState?: ChannelAccountState;
  resolveStateInput?: {
    configured: boolean;
    enabled: boolean;
  };
  assertSnapshot?: (snapshot: ChannelAccountSnapshot) => void;
  assertSummary?: (summary: Record<string, unknown>) => void;
};

export function installChannelStatusContractSuite<ResolvedAccount, Probe = unknown>(params: {
  plugin: Pick<ChannelPlugin<ResolvedAccount, Probe>, "id" | "config" | "status">;
  cases: readonly ChannelStatusContractCase<Probe>[];
}) {
  it("exposes the base status contract", () => {
    expect(params.plugin.status).toBeDefined();
    expect(typeof params.plugin.status?.buildAccountSnapshot).toBe("function");
  });

  if (params.plugin.status?.defaultRuntime) {
    it("status contract: default runtime is shaped like an account snapshot", () => {
      expect(typeof params.plugin.status?.defaultRuntime?.accountId).toBe("string");
    });
  }

  for (const testCase of params.cases) {
    it(`status contract: ${testCase.name}`, async () => {
      testCase.beforeTest?.();

      const account = params.plugin.config.resolveAccount(testCase.cfg, testCase.accountId);
      const snapshot = await params.plugin.status!.buildAccountSnapshot!({
        account,
        cfg: testCase.cfg,
        runtime: testCase.runtime,
        probe: testCase.probe,
      });

      expect(typeof snapshot.accountId).toBe("string");
      expect(snapshot.accountId.trim()).not.toBe("");
      testCase.assertSnapshot?.(snapshot);

      if (params.plugin.status?.buildChannelSummary) {
        const defaultAccountId =
          params.plugin.config.defaultAccountId?.(testCase.cfg) ?? testCase.accountId ?? "default";
        const summary = await params.plugin.status.buildChannelSummary({
          account,
          cfg: testCase.cfg,
          defaultAccountId,
          snapshot,
        });
        expect(summary).toEqual(expect.any(Object));
        testCase.assertSummary?.(summary);
      }

      if (testCase.expectedState && params.plugin.status?.resolveAccountState) {
        const state = params.plugin.status.resolveAccountState({
          account,
          cfg: testCase.cfg,
          configured: testCase.resolveStateInput?.configured ?? true,
          enabled: testCase.resolveStateInput?.enabled ?? true,
        });
        expect(state).toBe(testCase.expectedState);
      }
    });
  }
}

type PayloadLike = {
  mediaUrl?: string;
  mediaUrls?: string[];
  text?: string;
};

type SendResultLike = {
  messageId: string;
  [key: string]: unknown;
};

type ChunkingMode =
  | {
      longTextLength: number;
      maxChunkLength: number;
      mode: "split";
    }
  | {
      longTextLength: number;
      mode: "passthrough";
    };

export function installChannelOutboundPayloadContractSuite(params: {
  channel: string;
  chunking: ChunkingMode;
  createHarness: (params: { payload: PayloadLike; sendResults?: SendResultLike[] }) => {
    run: () => Promise<Record<string, unknown>>;
    sendMock: Mock;
    to: string;
  };
}) {
  it("text-only delegates to sendText", async () => {
    const { run, sendMock, to } = params.createHarness({
      payload: { text: "hello" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(to, "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: params.channel });
  });

  it("single media delegates to sendMedia", async () => {
    const { run, sendMock, to } = params.createHarness({
      payload: { text: "cap", mediaUrl: "https://example.com/a.jpg" },
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: params.channel });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const { run, sendMock, to } = params.createHarness({
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      },
      sendResults: [{ messageId: "m-1" }, { messageId: "m-2" }],
    });
    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      to,
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      to,
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: params.channel, messageId: "m-2" });
  });

  it("empty payload returns no-op", async () => {
    const { run, sendMock } = params.createHarness({ payload: {} });
    const result = await run();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: params.channel, messageId: "" });
  });

  if (params.chunking.mode === "passthrough") {
    it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
      const text = "a".repeat(params.chunking.longTextLength);
      const { run, sendMock, to } = params.createHarness({ payload: { text } });
      const result = await run();

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(to, text, expect.any(Object));
      expect(result).toMatchObject({ channel: params.channel });
    });
    return;
  }

  const chunking = params.chunking;

  it("chunking splits long text", async () => {
    const text = "a".repeat(chunking.longTextLength);
    const { run, sendMock } = params.createHarness({
      payload: { text },
      sendResults: [{ messageId: "c-1" }, { messageId: "c-2" }],
    });
    const result = await run();

    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendMock.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(chunking.maxChunkLength);
    }
    expect(result).toMatchObject({ channel: params.channel });
  });
}

export function primeChannelOutboundSendMock(
  sendMock: Mock,
  fallbackResult: Record<string, unknown>,
  sendResults: SendResultLike[] = [],
) {
  sendMock.mockReset();
  if (sendResults.length === 0) {
    sendMock.mockResolvedValue(fallbackResult);
    return;
  }
  for (const result of sendResults) {
    sendMock.mockResolvedValueOnce(result);
  }
}

type RuntimeGroupPolicyResolver = (
  params: ResolveProviderRuntimeGroupPolicyParams,
) => RuntimeGroupPolicyResolution;

export function installChannelRuntimeGroupPolicyFallbackSuite(params: {
  configuredLabel: string;
  defaultGroupPolicyUnderTest: "allowlist" | "disabled" | "open";
  missingConfigLabel: string;
  missingDefaultLabel: string;
  resolve: RuntimeGroupPolicyResolver;
}) {
  it(params.missingConfigLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it(params.configuredLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it(params.missingDefaultLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
      defaultGroupPolicy: params.defaultGroupPolicyUnderTest,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
}

export function expectChannelInboundContextContract(ctx: MsgContext) {
  expect(validateSenderIdentity(ctx)).toEqual([]);

  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }
}
