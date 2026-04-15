import { describePackageManifestContract } from "../../../test/helpers/plugins/package-manifest-contract.js";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  { pluginId: "bluebubbles", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "discord",
    pluginLocalRuntimeDeps: ["@buape/carbon", "@discordjs/opus", "discord-api-types", "opusscript"],
    mirroredRootRuntimeDeps: ["https-proxy-agent"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "feishu",
    pluginLocalRuntimeDeps: ["@larksuiteoapi/node-sdk"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "google", pluginLocalRuntimeDeps: ["@google/genai"] },
  {
    pluginId: "googlechat",
    mirroredRootRuntimeDeps: ["google-auth-library"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "irc", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "line", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "amazon-bedrock", pluginLocalRuntimeDeps: ["@aws-sdk/client-bedrock"] },
  {
    pluginId: "amazon-bedrock-mantle",
    pluginLocalRuntimeDeps: ["@aws/bedrock-token-generator"],
  },
  { pluginId: "matrix", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "mattermost", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "memory-lancedb",
    mirroredRootRuntimeDeps: ["@lancedb/lancedb", "openai"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "msteams", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "nextcloud-talk", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "nostr", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "openshell", pluginLocalRuntimeDeps: ["openshell"] },
  {
    pluginId: "slack",
    pluginLocalRuntimeDeps: ["@slack/bolt", "@slack/web-api"],
    mirroredRootRuntimeDeps: ["https-proxy-agent"],
  },
  { pluginId: "synology-chat", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "telegram",
    mirroredRootRuntimeDeps: ["@grammyjs/runner", "@grammyjs/transformer-throttler", "grammy"],
  },
  { pluginId: "tlon", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "twitch", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "voice-call", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "whatsapp",
    mirroredRootRuntimeDeps: ["@whiskeysockets/baileys", "jimp"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "zalo", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "zalouser", minHostVersionBaseline: "2026.3.22" },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}
