import { expect } from "vitest";
import type { AnyChannelPlugin as ChannelPlugin } from "../../types.plugin.js";
import type { channelPluginSurfaceKeys } from "./manifest.js";

function expectCallableHook<T>(adapter: T | undefined, keys: (keyof T)[]) {
  expect(keys.some((key) => typeof adapter?.[key] === "function")).toBe(true);
}

export function expectChannelSurfaceContract(params: {
  plugin: Pick<ChannelPlugin, "id" | "setupContract" | (typeof channelPluginSurfaceKeys)[number]>;
  surface: (typeof channelPluginSurfaceKeys)[number];
}) {
  const { plugin, surface } = params;

  if (surface === "actions") {
    return expect(typeof plugin.actions?.describeMessageTool).toBe("function");
  }

  if (surface === "setup") {
    return expect(typeof (plugin.setupContract ?? plugin.setup)?.applyAccountConfig).toBe(
      "function",
    );
  }

  if (surface === "status") {
    return expect(typeof plugin.status?.buildAccountSnapshot).toBe("function");
  }

  if (surface === "outbound") {
    expect(["direct", "gateway", "hybrid"]).toContain(plugin.outbound?.deliveryMode);
    expectCallableHook(plugin.outbound, [
      "sendPayload",
      "sendFormattedText",
      "sendFormattedMedia",
      "sendText",
      "sendMedia",
      "sendPoll",
    ]);
    return;
  }

  if (surface === "messaging") {
    const messaging = plugin.messaging;
    expectCallableHook(messaging, [
      "normalizeTarget",
      "inferTargetChatType",
      "buildCrossContextPresentation",
      "hasStructuredReplyPayload",
      "formatTargetDisplay",
      "resolveOutboundSessionRoute",
    ]);
    const resolver = messaging?.targetResolver;
    if (resolver) {
      // Optional resolvers must expose callable hooks or stable tool-UX metadata.
      for (const hook of [resolver.looksLikeId, resolver.resolveTarget]) {
        if (hook) {
          expect(typeof hook).toBe("function");
        }
      }
      if (resolver.hint !== undefined) {
        expect(typeof resolver.hint).toBe("string");
        expect(resolver.hint.trim()).not.toBe("");
      }
      if (resolver.reservedLiterals !== undefined) {
        expect(Array.isArray(resolver.reservedLiterals)).toBe(true);
        expect(
          resolver.reservedLiterals.every((value) => typeof value === "string" && value.trim()),
        ).toBe(true);
      }
    }
    return;
  }

  if (surface === "threading") {
    expectCallableHook(plugin.threading, [
      "resolveReplyToMode",
      "buildToolContext",
      "resolveAutoThreadId",
      "resolveReplyTransport",
      "resolveFocusedBinding",
      // source-reply-mirror.ts permits target matching without reply-shaping hooks.
      "matchesToolContextTarget",
    ]);
    return;
  }

  if (surface === "directory") {
    expectCallableHook(plugin.directory, [
      "self",
      "listPeers",
      "listPeersLive",
      "listGroups",
      "listGroupsLive",
      "listGroupMembers",
    ]);
    return;
  }

  expectCallableHook(plugin.gateway, [
    "startAccount",
    "stopAccount",
    "loginWithQrStart",
    "loginWithQrWait",
    "logoutAccount",
  ]);
}
