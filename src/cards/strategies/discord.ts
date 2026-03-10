/**
 * Discord rendering strategy for Adaptive Cards.
 *
 * Converts AC elements to Discord embeds + button components.
 */

import type { ParsedAdaptiveCard } from "../parse.js";
import type { CardRenderResult, CardRenderStrategy } from "../types.js";

type AcElement = Record<string, unknown>;

/** Safely coerce an unknown AC property to string. */
function str(val: unknown, fallback = ""): string {
  if (typeof val === "string") {
    return val;
  }
  if (val == null) {
    return fallback;
  }
  return JSON.stringify(val);
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
}

interface DiscordButton {
  type: 2; // Button component type
  style: number;
  label: string;
  url?: string;
  custom_id?: string;
}

function buildEmbedFromBody(body: unknown[]): DiscordEmbed {
  const embed: DiscordEmbed = {};
  const descParts: string[] = [];

  for (const raw of body) {
    const el = raw as AcElement;
    switch (el.type) {
      case "TextBlock": {
        const text = str(el.text);
        const weight = el.weight as string | undefined;
        // First Bolder TextBlock becomes the embed title
        if (weight === "Bolder" && !embed.title) {
          embed.title = text;
        } else {
          descParts.push(weight === "Bolder" ? `**${text}**` : text);
        }
        break;
      }
      case "FactSet": {
        const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
        if (facts?.length) {
          embed.fields ??= [];
          for (const f of facts) {
            embed.fields.push({
              name: f.title ?? "",
              value: f.value ?? "",
              inline: true,
            });
          }
        }
        break;
      }
      case "Image": {
        const url = str(el.url);
        if (url) {
          embed.image = { url };
        }
        break;
      }
      case "ColumnSet": {
        const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
        if (columns?.length) {
          const nested = columns.flatMap((col) => col.items ?? []);
          const sub = buildEmbedFromBody(nested);
          if (sub.title && !embed.title) {
            embed.title = sub.title;
          }
          if (sub.description) {
            descParts.push(sub.description);
          }
          if (sub.fields?.length) {
            embed.fields ??= [];
            embed.fields.push(...sub.fields);
          }
          if (sub.image && !embed.image) {
            embed.image = sub.image;
          }
        }
        break;
      }
      case "Container": {
        const items = el.items as AcElement[] | undefined;
        if (items?.length) {
          const sub = buildEmbedFromBody(items);
          if (sub.title && !embed.title) {
            embed.title = sub.title;
          }
          if (sub.description) {
            descParts.push(sub.description);
          }
          if (sub.fields?.length) {
            embed.fields ??= [];
            embed.fields.push(...sub.fields);
          }
          if (sub.image && !embed.image) {
            embed.image = sub.image;
          }
        }
        break;
      }
      // skip unknown element types
    }
  }

  if (descParts.length > 0) {
    const desc = descParts.join("\n");
    // Discord limits embed description to 4096 chars
    embed.description = desc.length > 4096 ? desc.slice(0, 4093) + "..." : desc;
  }

  // Discord limits: title 256 chars, 25 fields max, field name/value 1024 chars
  if (embed.title && embed.title.length > 256) {
    embed.title = embed.title.slice(0, 253) + "...";
  }
  if (embed.fields) {
    embed.fields = embed.fields.slice(0, 25).map((f) => ({
      name: f.name.length > 1024 ? f.name.slice(0, 1021) + "..." : f.name || "\u200B",
      value: f.value.length > 1024 ? f.value.slice(0, 1021) + "..." : f.value || "\u200B",
      inline: f.inline,
    }));
  }

  return embed;
}

function buildActionRow(actions: unknown[]): unknown {
  const buttons: DiscordButton[] = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = str(action.title);
    if (!label) {
      continue;
    }
    if (action.type === "Action.OpenUrl") {
      // Style 5 = Link
      const url = str(action.url);
      if (!url) {
        continue; // skip: Discord rejects link buttons with an empty URL
      }
      buttons.push({
        type: 2,
        style: 5,
        label,
        url,
      });
    } else if (action.type === "Action.Submit") {
      // Style 1 = Primary
      const customId = typeof action.id === "string" ? action.id : `ac_submit_${buttons.length}`;
      buttons.push({
        type: 2,
        style: 1,
        label,
        custom_id: customId,
      });
    }
  }
  if (buttons.length === 0) {
    return null;
  }
  // Action row component (type 1)
  return { type: 1, components: buttons };
}

export const discordStrategy: CardRenderStrategy = {
  name: "discord",
  render(parsed: ParsedAdaptiveCard): CardRenderResult {
    const embed = buildEmbedFromBody(parsed.card.body);
    const embeds = [embed];

    const components: unknown[] = [];
    if (parsed.card.actions?.length) {
      const actionRow = buildActionRow(parsed.card.actions);
      if (actionRow) {
        components.push(actionRow);
      }
    }

    return {
      type: "discord",
      embeds,
      components: components.length > 0 ? components : undefined,
      fallback: parsed.fallbackText,
    };
  },
};
