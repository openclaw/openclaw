import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deprecatedPublicPluginSdkEntrypoints,
  publicPluginSdkSubpaths as pluginSdkSubpaths,
} from "../../../scripts/lib/plugin-sdk-entries.mts";
import * as channelActionsDirectSdk from "../../plugin-sdk/channel-actions.js";
import * as channelOutboundDirectSdk from "../../plugin-sdk/channel-outbound.js";
import * as coreDirectSdk from "../../plugin-sdk/core.js";

const representativeRuntimeSmokeSubpaths = [
  "channel-runtime-context",
  "conversation-runtime",
] as const;
const importResolvedPluginSdkSubpath = async (specifier: string) => import(specifier);

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 36 ||
    code === 95
  );
}

function sourceMentionsIdentifier(source: string, name: string): boolean {
  let fromIndex = 0;
  while (true) {
    const matchIndex = source.indexOf(name, fromIndex);
    if (matchIndex === -1) {
      return false;
    }
    const beforeCode = matchIndex === 0 ? -1 : source.charCodeAt(matchIndex - 1);
    const afterIndex = matchIndex + name.length;
    const afterCode = afterIndex >= source.length ? -1 : source.charCodeAt(afterIndex);
    if (!isIdentifierCode(beforeCode) && !isIdentifierCode(afterCode)) {
      return true;
    }
    fromIndex = matchIndex + 1;
  }
}

function expectSourceMentions(subpath: string, names: readonly string[]) {
  const source = readFileSync(new URL(`../../plugin-sdk/${subpath}.ts`, import.meta.url), "utf8");
  const missing = names.filter((name) => !sourceMentionsIdentifier(source, name));
  expect(missing, `${subpath} missing exports`).toStrictEqual([]);
}

describe("plugin-sdk subpath exports", () => {
  it("keeps focused SDK subpaths importable", async () => {
    const channelActionsSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-actions",
    );
    const pluginEntrySdk = await importResolvedPluginSdkSubpath("openclaw/plugin-sdk/plugin-entry");
    const channelOutboundSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-outbound",
    );
    const channelPairingSdk = await importResolvedPluginSdkSubpath(
      "openclaw/plugin-sdk/channel-pairing",
    );
    const representativeModules = [];
    for (const id of representativeRuntimeSmokeSubpaths) {
      representativeModules.push(await importResolvedPluginSdkSubpath(`openclaw/plugin-sdk/${id}`));
    }

    expect(pluginEntrySdk.definePluginEntry).toBe(coreDirectSdk.definePluginEntry);
    expect(channelActionsSdk.optionalStringEnum).toBe(channelActionsDirectSdk.optionalStringEnum);
    expect(channelActionsSdk.stringEnum).toBe(channelActionsDirectSdk.stringEnum);
    expectSourceMentions("error-runtime", [
      "formatUncaughtError",
      "isApprovalNotFoundError",
      "PlatformMessageNotDispatchedError",
    ]);

    expect(channelOutboundSdk.createDraftStreamLoop).toBe(
      channelOutboundDirectSdk.createDraftStreamLoop,
    );
    expect(channelOutboundSdk.createFinalizableDraftLifecycle).toBe(
      channelOutboundDirectSdk.createFinalizableDraftLifecycle,
    );
    expect(channelOutboundSdk.createChannelRunQueue).toBe(
      channelOutboundDirectSdk.createChannelRunQueue,
    );
    expect(channelOutboundSdk.runPassiveAccountLifecycle).toBe(
      channelOutboundDirectSdk.runPassiveAccountLifecycle,
    );
    expect(channelOutboundSdk.createRunStateMachine).toBe(
      channelOutboundDirectSdk.createRunStateMachine,
    );
    expect(channelOutboundSdk.createArmableStallWatchdog).toBe(
      channelOutboundDirectSdk.createArmableStallWatchdog,
    );

    expectSourceMentions("channel-pairing", [
      "createChannelPairingController",
      "createChannelPairingChallengeIssuer",
      "createLoggedPairingApprovalNotifier",
      "createPairingPrefixStripper",
      "readChannelAllowFromStoreSync",
      "createTextPairingAdapter",
    ]);
    expect("createScopedPairingAccess" in channelPairingSdk).toBe(false);

    expectSourceMentions("channel-outbound", [
      "createChannelMessageReplyPipeline",
      "createTypingCallbacks",
      "createReplyPrefixContext",
      "createReplyPrefixOptions",
      "resolveChannelMessageSourceReplyDeliveryMode",
    ]);
    expect(channelOutboundSdk.createTypingCallbacks).toBe(
      channelOutboundDirectSdk.createTypingCallbacks,
    );
    expect(channelOutboundSdk.createReplyPrefixContext).toBe(
      channelOutboundDirectSdk.createReplyPrefixContext,
    );
    expect(channelOutboundSdk.createReplyPrefixOptions).toBe(
      channelOutboundDirectSdk.createReplyPrefixOptions,
    );
    expect(channelOutboundSdk.resolveChannelMessageSourceReplyDeliveryMode).toBe(
      channelOutboundDirectSdk.resolveChannelMessageSourceReplyDeliveryMode,
    );

    expect(pluginSdkSubpaths.length).toBeGreaterThan(representativeRuntimeSmokeSubpaths.length);
    for (const [index, id] of representativeRuntimeSmokeSubpaths.entries()) {
      const mod = representativeModules[index];
      expect(typeof mod).toBe("object");
      expect(Object.keys(mod as object).length, `subpath ${id} should resolve`).toBeGreaterThan(0);
    }
  });

  it("keeps deprecated public SDK shims importable during migrations", async () => {
    expect(deprecatedPublicPluginSdkEntrypoints.length).toBeGreaterThan(0);

    for (const subpath of deprecatedPublicPluginSdkEntrypoints) {
      const mod = await importResolvedPluginSdkSubpath(`openclaw/plugin-sdk/${subpath}`);
      expect(typeof mod, `deprecated subpath ${subpath} should resolve`).toBe("object");
    }
  });
});
