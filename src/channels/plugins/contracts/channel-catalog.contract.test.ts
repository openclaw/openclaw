import fs from "node:fs";
import path from "node:path";
import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

function resolveWorkspacePrereleaseNpmSpec(pluginDir: string): string {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "extensions", pluginDir, "package.json"), "utf8"),
  ) as { name?: string; version?: string; openclaw?: { install?: { npmSpec?: string } } };
  const npmSpec = packageJson.openclaw?.install?.npmSpec ?? packageJson.name;
  if (!npmSpec || !packageJson.version) {
    throw new Error(`missing package metadata for ${pluginDir}`);
  }
  return packageJson.version.includes("-") ? `${npmSpec}@${packageJson.version}` : npmSpec;
}

describeChannelCatalogEntryContract({
  channelId: "msteams",
  npmSpec: resolveWorkspacePrereleaseNpmSpec("msteams"),
  alias: "teams",
});

const whatsappMeta = {
  id: "whatsapp",
  label: "WhatsApp",
  selectionLabel: "WhatsApp (QR link)",
  detailLabel: "WhatsApp Web",
  docsPath: "/channels/whatsapp",
  blurb: "works with your own number; recommend a separate phone + eSIM.",
};

describeBundledMetadataOnlyChannelCatalogContract({
  pluginId: "whatsapp",
  packageName: "@openclaw/whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  defaultChoice: "npm",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: whatsappMeta,
  packageName: "@openclaw/whatsapp",
  pluginId: "whatsapp",
  externalNpmSpec: "@vendor/whatsapp-fork",
  externalLabel: "WhatsApp Fork",
});

describeChannelCatalogEntryContract({
  channelId: "wecom",
  npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.23",
  alias: "wework",
});

describeChannelCatalogEntryContract({
  channelId: "yuanbao",
  npmSpec: "openclaw-plugin-yuanbao@2.11.0",
  alias: "yb",
});
