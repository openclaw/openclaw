import type { ParsedAdaptiveCard } from "./parse.js";

export type CardRenderResult =
  | { type: "text"; text: string }
  | {
      type: "telegram";
      text: string;
      replyMarkup?: {
        inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
      };
    }
  | { type: "slack"; blocks: unknown[]; fallback: string }
  | {
      type: "discord";
      embeds: unknown[];
      components?: unknown[];
      fallback: string;
    }
  | {
      type: "attachment";
      contentType: string;
      content: unknown;
      fallback: string;
    };

export interface CardRenderStrategy {
  name: string;
  render(parsed: ParsedAdaptiveCard): CardRenderResult;
}
