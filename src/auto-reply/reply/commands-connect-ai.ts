import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const GENIE_WEB_SETTINGS_URL = "https://genie.deva.me/app/settings?tab=server";

const PROVIDER_INSTRUCTIONS: Record<string, { label: string; text: string }> = {
  gemini: {
    label: "Gemini (Google)",
    text: [
      "To connect your Gemini subscription:",
      "",
      "1. Open the LLM Integrations section in your server settings:",
      GENIE_WEB_SETTINGS_URL,
      "",
      '2. Select the "Gemini" tab.',
      "3. Follow the prompts to authenticate with your Google account.",
      "",
      "Once connected, you can use Gemini models in your conversations.",
    ].join("\n"),
  },
  codex: {
    label: "OpenAI (Codex)",
    text: [
      "To connect your OpenAI / Codex subscription:",
      "",
      "1. Open the LLM Integrations section in your server settings:",
      GENIE_WEB_SETTINGS_URL,
      "",
      '2. Select the "Codex" tab.',
      "3. Follow the prompts to authenticate with your OpenAI account.",
      "",
      "Once connected, you can use OpenAI models in your conversations.",
    ].join("\n"),
  },
  anthropic: {
    label: "Anthropic (Claude)",
    text: [
      "To connect your Anthropic / Claude subscription:",
      "",
      "1. Open the LLM Integrations section in your server settings:",
      GENIE_WEB_SETTINGS_URL,
      "",
      '2. Select the "Claude" tab.',
      '3. Use the "Claude setup-token" method (recommended) or OAuth.',
      "",
      "For setup-token: run `openclaw setup-token` in your terminal to generate a long-lived token, then paste it in the settings page.",
      "",
      "Once connected, you can use Claude models in your conversations.",
    ].join("\n"),
  },
};

export const handleConnectAiSubscriptionCommand: CommandHandler = async (
  params,
  allowTextCommands,
) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (
    normalized !== "/connect_ai_subscription" &&
    !normalized.startsWith("/connect_ai_subscription ")
  ) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /connect_ai_subscription from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const parts = normalized.split(/\s+/);
  const provider = parts[1]?.toLowerCase();

  if (!provider) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Connect an AI subscription to use additional models.",
          "",
          "Usage: /connect_ai_subscription <provider>",
          "",
          "Providers: gemini, codex, anthropic",
          "",
          `Or open the settings page directly: ${GENIE_WEB_SETTINGS_URL}`,
        ].join("\n"),
      },
    };
  }

  const info = PROVIDER_INSTRUCTIONS[provider];
  if (!info) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          `Unknown provider: ${provider}`,
          "",
          "Available providers: gemini, codex, anthropic",
        ].join("\n"),
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: info.text },
  };
};
