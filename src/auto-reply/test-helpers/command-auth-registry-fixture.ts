import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { beforeEach } from "vitest";
import { normalizeE164 } from "../../plugin-sdk/account-resolution.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

function formatDiscordAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeStringEntries(allowFrom)
    .map((entry) => entry.replace(/^(discord|user|pk):/i, "").replace(/^<@!?(\d+)>$/, "$1"))
    .map((entry) => lowercasePreservingWhitespace(entry));
}

function normalizePhoneAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeStringEntries(allowFrom)
    .map((entry) => {
      if (entry === "*") {
        return entry;
      }
      const stripped = entry.replace(/^whatsapp:/i, "").trim();
      if (/@g\.us$/i.test(stripped)) {
        return stripped;
      }
      // WhatsApp LID values are numeric identifiers; test fixtures map them like phone ids.
      const match = stripped.match(/^(\d+)(?:(?::\d+)?@s\.whatsapp\.net|@lid)$/i);
      if (match) {
        return normalizeE164(
          expectDefined(match[1], "command auth registry fixture regex capture 1"),
        );
      }
      return stripped.includes("@") ? null : normalizeE164(stripped);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function resolveChannelAllowFrom(
  cfg: Record<string, unknown>,
  channelId: string,
): Array<string | number> | undefined {
  const channels = asOptionalObjectRecord(cfg.channels);
  const allowFrom = asOptionalObjectRecord(channels?.[channelId])?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : undefined;
}

const createCommandAuthRegistry = () =>
  createTestRegistry(
    [
      { id: "discord", format: formatDiscordAllowFromEntries },
      { id: "whatsapp", format: normalizePhoneAllowFromEntries },
    ].map(({ id, format }) => ({
      pluginId: id,
      plugin: {
        ...createOutboundTestPlugin({ id, outbound: { deliveryMode: "direct" } }),
        config: {
          listAccountIds: () => [],
          resolveAllowFrom: ({ cfg }: { cfg: Record<string, unknown> }) =>
            resolveChannelAllowFrom(cfg, id),
          formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
            format(allowFrom),
        },
      },
      source: "test",
    })),
  );

export function installDiscordRegistryHooks() {
  beforeEach(({ onTestFinished }) => {
    const previous = captureActivePluginRegistrySnapshot();
    onTestFinished(() => {
      rollbackStagedPluginRegistry(previous);
    });
    // Stage without retiring the predecessor; roll back after caller cleanup
    // so its original lifecycle authority survives this temporary fixture.
    stageActivePluginRegistry(createCommandAuthRegistry(), null, "default");
  });
}
