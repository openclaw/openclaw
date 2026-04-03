import { ConfigSectionPage } from "@/components/shared/config-section-page";

export function CommunicationsPage() {
  return (
    <ConfigSectionPage
      title="Communications"
      section="channels"
      fields={[
        { key: "telegram.enabled", label: "Telegram Enabled", type: "boolean" },
        { key: "telegram.token", label: "Telegram Bot Token", type: "text" },
        { key: "whatsapp.enabled", label: "WhatsApp Enabled", type: "boolean" },
        { key: "discord.enabled", label: "Discord Enabled", type: "boolean" },
        { key: "discord.token", label: "Discord Bot Token", type: "text" },
        { key: "slack.enabled", label: "Slack Enabled", type: "boolean" },
        { key: "slack.token", label: "Slack Bot Token", type: "text" },
      ]}
    />
  );
}
