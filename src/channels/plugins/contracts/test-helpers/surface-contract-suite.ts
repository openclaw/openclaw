import { expect } from "vitest";
import type { AnyChannelPlugin as ChannelPlugin } from "../../types.plugin.js";
import type { channelPluginSurfaceKeys } from "./manifest.js";

function expectCallableHook(...hooks: unknown[]) {
  expect(hooks.some((value) => typeof value === "function")).toBe(true);
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
    const outbound = plugin.outbound;
    expect(["direct", "gateway", "hybrid"]).toContain(outbound?.deliveryMode);
    expectCallableHook(
      outbound?.sendPayload,
      outbound?.sendFormattedText,
      outbound?.sendFormattedMedia,
      outbound?.sendText,
      outbound?.sendMedia,
      outbound?.sendPoll,
    );
    return;
  }

  if (surface === "messaging") {
    const messaging = plugin.messaging;
    expectCallableHook(
      messaging?.normalizeTarget,
      messaging?.inferTargetChatType,
      messaging?.buildCrossContextPresentation,
      messaging?.hasStructuredReplyPayload,
      messaging?.formatTargetDisplay,
      messaging?.resolveOutboundSessionRoute,
    );
    if (messaging?.targetResolver) {
      // Optional resolvers must expose callable hooks or stable tool-UX metadata.
      for (const hook of [
        messaging.targetResolver.looksLikeId,
        messaging.targetResolver.resolveTarget,
      ]) {
        if (hook) {
          expect(typeof hook).toBe("function");
        }
      }
      if (messaging.targetResolver.hint !== undefined) {
        expect(typeof messaging.targetResolver.hint).toBe("string");
        expect(messaging.targetResolver.hint.trim()).not.toBe("");
      }
      if (messaging.targetResolver.reservedLiterals !== undefined) {
        expect(Array.isArray(messaging.targetResolver.reservedLiterals)).toBe(true);
        expect(
          messaging.targetResolver.reservedLiterals.every(
            (value) => typeof value === "string" && value.trim(),
          ),
        ).toBe(true);
      }
    }
    return;
  }

  if (surface === "threading") {
    const threading = plugin.threading;
    expectCallableHook(
      threading?.resolveReplyToMode,
      threading?.buildToolContext,
      threading?.resolveAutoThreadId,
      threading?.resolveReplyTransport,
      threading?.resolveFocusedBinding,
      // source-reply-mirror.ts permits target matching without reply-shaping hooks.
      threading?.matchesToolContextTarget,
    );
    return;
  }

  if (surface === "directory") {
    const directory = plugin.directory;
    expectCallableHook(
      directory?.self,
      directory?.listPeers,
      directory?.listPeersLive,
      directory?.listGroups,
      directory?.listGroupsLive,
      directory?.listGroupMembers,
    );
    return;
  }

  const gateway = plugin.gateway;
  expectCallableHook(
    gateway?.startAccount,
    gateway?.stopAccount,
    gateway?.loginWithQrStart,
    gateway?.loginWithQrWait,
    gateway?.logoutAccount,
  );
}
