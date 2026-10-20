import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import type { RuntimeEnv } from "../../../../runtime.js";
import type {
  ChannelDirectoryEntry,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "../../types.core.js";
import type { ChannelPlugin } from "../../types.plugin.js";

type ChannelReplyTransport = NonNullable<
  ReturnType<NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>>
>;
type ChannelFocusedBindingContext = NonNullable<
  ReturnType<NonNullable<ChannelThreadingAdapter["resolveFocusedBinding"]>>
>;

const contractRuntime = new Proxy(Object.create(null), {
  get(_target, property) {
    throw new Error(`Directory contract unexpectedly accessed runtime.${String(property)}`);
  },
}) as RuntimeEnv;

function expectOptionalType(value: unknown, type: string | string[]) {
  if (value !== undefined) {
    expect(typeof type === "string" ? [type] : type).toContain(typeof value);
  }
}

function expectDirectoryEntryShape(entry: ChannelDirectoryEntry) {
  expect(["user", "group", "channel"]).toContain(entry.kind);
  expect(typeof entry.id).toBe("string");
  expect(entry.id.trim()).not.toBe("");
  for (const value of [entry.name, entry.handle, entry.avatarUrl]) {
    expectOptionalType(value, "string");
  }
  expectOptionalType(entry.rank, "number");
}

function expectThreadingToolContextShape(context: ChannelThreadingToolContext) {
  for (const value of [
    context.currentChannelId,
    context.currentChannelProvider,
    context.currentThreadTs,
  ]) {
    expectOptionalType(value, "string");
  }
  expectOptionalType(context.currentMessageId, ["string", "number"]);
  if (context.replyToMode !== undefined) {
    expect(["off", "first", "all"]).toContain(context.replyToMode);
  }
  expectOptionalType(context.hasRepliedRef, "object");
  expectOptionalType(context.skipCrossContextDecoration, "boolean");
}

function expectReplyTransportShape(transport: ChannelReplyTransport) {
  expectOptionalType(transport.replyToId ?? undefined, "string");
  expectOptionalType(transport.threadId ?? undefined, ["string", "number"]);
}

function expectFocusedBindingShape(binding: ChannelFocusedBindingContext) {
  expect(typeof binding.conversationId).toBe("string");
  expect(binding.conversationId.trim()).not.toBe("");
  expectOptionalType(binding.parentConversationId, "string");
  expect(["current", "child"]).toContain(binding.placement);
  expect(typeof binding.labelNoun).toBe("string");
  expect(binding.labelNoun.trim()).not.toBe("");
}

export function expectChannelThreadingReturnValuesNormalized(
  plugin: Pick<ChannelPlugin, "id" | "threading">,
) {
  const threading = plugin.threading;
  expect(threading).toBeDefined();
  const account = () => ({ cfg: {} satisfies OpenClawConfig, accountId: "default" });
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
      threading.resolveReplyToMode({ ...account(), chatType: "group" }),
    );
  }

  const repliedRef = { value: false };
  const toolContext = threading?.buildToolContext?.({
    ...account(),
    context: context(),
    hasRepliedRef: repliedRef,
  });

  if (toolContext) {
    expectThreadingToolContextShape(toolContext);
    if (toolContext.hasRepliedRef) {
      expect(toolContext.hasRepliedRef).toBe(repliedRef);
    }
  }

  const autoThreadId = threading?.resolveAutoThreadId?.({
    ...account(),
    to: "group:test",
    toolContext,
    replyToId: null,
  });
  if (autoThreadId !== undefined) {
    expect(typeof autoThreadId).toBe("string");
    expect(autoThreadId.trim()).not.toBe("");
  }

  const replyTransport = threading?.resolveReplyTransport?.({
    ...account(),
    threadId: "thread-0",
    replyToId: "msg-0",
  });
  if (replyTransport) {
    expectReplyTransportShape(replyTransport);
  }

  const focusedBinding = threading?.resolveFocusedBinding?.({
    ...account(),
    context: context(),
  });
  if (focusedBinding) {
    expectFocusedBindingShape(focusedBinding);
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
