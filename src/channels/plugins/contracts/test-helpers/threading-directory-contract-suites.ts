import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import type { RuntimeEnv } from "../../../../runtime.js";
import type { ChannelDirectoryEntry } from "../../types.core.js";
import type { AnyChannelPlugin, ChannelPlugin } from "../../types.plugin.js";
import type { channelPluginSurfaceKeys } from "./manifest.js";

const contractRuntime = new Proxy(Object.create(null), {
  get(_target, property) {
    throw new Error(`Directory contract unexpectedly accessed runtime.${String(property)}`);
  },
}) as RuntimeEnv;

function expectOptionalType(type: string | string[], ...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined) {
      expect(typeof type === "string" ? [type] : type).toContain(typeof value);
    }
  }
}

function expectNonemptyString(value: string) {
  expect(typeof value).toBe("string");
  expect(value.trim()).not.toBe("");
}

function expectDirectoryEntryShape(entry: ChannelDirectoryEntry) {
  expect(["user", "group", "channel"]).toContain(entry.kind);
  expectNonemptyString(entry.id);
  expectOptionalType("string", entry.name, entry.handle, entry.avatarUrl);
  expectOptionalType("number", entry.rank);
}

export function expectChannelThreadingReturnValuesNormalized(
  plugin: Pick<ChannelPlugin, "id" | "threading">,
) {
  const threading = plugin.threading;
  expect(threading).toBeDefined();
  const account = <const T>(extra: T) => ({ cfg: {}, accountId: "default", ...extra });
  const context = () =>
    ({
      Channel: "group:test",
      From: "user:test",
      To: "group:test",
      ChatType: "group",
      CurrentMessageId: "msg-1",
      ReplyToId: "msg-0",
      ReplyToIdFull: "thread-0",
      MessageThreadId: "thread-0",
      NativeChannelId: "native:test",
    }) as const;

  if (threading?.resolveReplyToMode) {
    expect(["off", "first", "all"]).toContain(
      threading.resolveReplyToMode(account({ chatType: "group" })),
    );
  }

  const repliedRef = { value: false };
  const toolContext = threading?.buildToolContext?.(
    account({ context: context(), hasRepliedRef: repliedRef }),
  );

  if (toolContext) {
    expectOptionalType(
      "string",
      toolContext.currentChannelId,
      toolContext.currentChannelProvider,
      toolContext.currentThreadTs,
    );
    expectOptionalType(["string", "number"], toolContext.currentMessageId);
    if (toolContext.replyToMode !== undefined) {
      expect(["off", "first", "all"]).toContain(toolContext.replyToMode);
    }
    expectOptionalType("object", toolContext.hasRepliedRef);
    expectOptionalType("boolean", toolContext.skipCrossContextDecoration);
    if (toolContext.hasRepliedRef) {
      expect(toolContext.hasRepliedRef).toBe(repliedRef);
    }
  }

  const autoThreadId = threading?.resolveAutoThreadId?.(
    account({ to: "group:test", toolContext, replyToId: null }),
  );
  if (autoThreadId !== undefined) {
    expectNonemptyString(autoThreadId);
  }

  const replyTransport = threading?.resolveReplyTransport?.(
    account({ threadId: "thread-0", replyToId: "msg-0" }),
  );
  if (replyTransport) {
    expectOptionalType("string", replyTransport.replyToId ?? undefined);
    expectOptionalType(["string", "number"], replyTransport.threadId ?? undefined);
  }

  const focusedBinding = threading?.resolveFocusedBinding?.(account({ context: context() }));
  if (focusedBinding) {
    expectNonemptyString(focusedBinding.conversationId);
    expectOptionalType("string", focusedBinding.parentConversationId);
    expect(["current", "child"]).toContain(focusedBinding.placement);
    expectNonemptyString(focusedBinding.labelNoun);
  }
}

export async function expectChannelDirectoryBaseContract(params: {
  plugin: Pick<ChannelPlugin, "id" | "directory">;
  coverage?: "lookups" | "presence";
  cfg?: OpenClawConfig;
  accountId?: string;
}) {
  const directory = params.plugin.directory;
  expect(directory).toBeDefined();
  const cfg =
    params.cfg ??
    ({
      channels: {
        [params.plugin.id]: { enabled: false },
      },
    } as unknown as OpenClawConfig);
  const accountId = params.accountId ?? "default";
  const lookup = { cfg, accountId, runtime: contractRuntime };

  if (params.coverage === "presence") {
    // Presence-only channels advertise a directory surface but cannot perform
    // deterministic offline lookup calls in shared contract fixtures.
    return;
  }
  const self = await directory?.self?.({ ...lookup });
  if (self) {
    expectDirectoryEntryShape(self);
  }

  const checkEntries = (entries: ChannelDirectoryEntry[]) => {
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expectDirectoryEntryShape(entry);
    }
  };
  checkEntries((await directory?.listPeers?.({ ...lookup, query: "", limit: 5 })) ?? []);
  const groups = (await directory?.listGroups?.({ ...lookup, query: "", limit: 5 })) ?? [];
  checkEntries(groups);

  if (directory?.listGroupMembers && groups[0]?.id) {
    const members = await directory.listGroupMembers({
      ...lookup,
      groupId: groups[0].id,
      limit: 5,
    });
    checkEntries(members);
  }
}

type Surface = (typeof channelPluginSurfaceKeys)[number];
const hooks = {
  actions: ["describeMessageTool"],
  setup: ["applyAccountConfig"],
  status: ["buildAccountSnapshot"],
  outbound: [
    "sendPayload",
    "sendFormattedText",
    "sendFormattedMedia",
    "sendText",
    "sendMedia",
    "sendPoll",
  ],
  messaging: [
    "normalizeTarget",
    "inferTargetChatType",
    "buildCrossContextPresentation",
    "hasStructuredReplyPayload",
    "formatTargetDisplay",
    "resolveOutboundSessionRoute",
  ],
  // Target matching also supports source-reply mirroring without reply-shaping hooks.
  threading: [
    "resolveReplyToMode",
    "buildToolContext",
    "resolveAutoThreadId",
    "resolveReplyTransport",
    "resolveFocusedBinding",
    "matchesToolContextTarget",
  ],
  directory: [
    "self",
    "listPeers",
    "listPeersLive",
    "listGroups",
    "listGroupsLive",
    "listGroupMembers",
  ],
  gateway: ["startAccount", "stopAccount", "loginWithQrStart", "loginWithQrWait", "logoutAccount"],
} satisfies { [S in Surface]: (keyof NonNullable<AnyChannelPlugin[S]>)[] };

export function expectChannelSurfaceContract({
  plugin,
  surface,
}: {
  plugin: Pick<AnyChannelPlugin, "id" | "setupContract" | Surface>;
  surface: Surface;
}) {
  const adapter = surface === "setup" ? (plugin.setupContract ?? plugin.setup) : plugin[surface];
  expect(
    hooks[surface].some((key) => adapter && typeof Reflect.get(adapter, key) === "function"),
  ).toBe(true);
  if (surface === "outbound") {
    expect(["direct", "gateway", "hybrid"]).toContain(plugin.outbound?.deliveryMode);
  }
  const resolver = surface === "messaging" ? plugin.messaging?.targetResolver : undefined;
  if (!resolver) {
    return;
  }
  for (const hook of [resolver.looksLikeId, resolver.resolveTarget]) {
    if (hook) {
      expect(typeof hook).toBe("function");
    }
  }
  if (resolver.hint !== undefined) {
    expectNonemptyString(resolver.hint);
  }
  if (resolver.reservedLiterals !== undefined) {
    expect(Array.isArray(resolver.reservedLiterals)).toBe(true);
    expect(
      resolver.reservedLiterals.every((value) => typeof value === "string" && value.trim()),
    ).toBe(true);
  }
}
