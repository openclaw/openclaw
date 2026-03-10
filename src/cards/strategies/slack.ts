/**
 * Slack Block Kit rendering strategy for Adaptive Cards.
 *
 * Converts AC elements to Slack blocks (section, image, actions, divider).
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

function renderTextBlock(el: AcElement): unknown {
  const text = str(el.text);
  const weight = el.weight as string | undefined;
  const formatted = weight === "Bolder" ? `*${text}*` : text;
  return {
    type: "section",
    text: { type: "mrkdwn", text: formatted },
  };
}

function renderFactSet(el: AcElement): unknown[] {
  const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
  if (!facts?.length) {
    return [];
  }
  const fields = facts.map((f) => ({
    type: "mrkdwn",
    text: `*${f.title ?? ""}*\n${f.value ?? ""}`,
  }));
  // Slack limits section blocks to 10 fields; split into chunks if needed
  const blocks: unknown[] = [];
  for (let i = 0; i < fields.length; i += 10) {
    blocks.push({ type: "section", fields: fields.slice(i, i + 10) });
  }
  return blocks;
}

function renderImage(el: AcElement): unknown {
  const url = str(el.url);
  const alt = str(el.altText) || str(el.alt) || "image";
  if (!url) {
    return null;
  }
  return {
    type: "image",
    image_url: url,
    alt_text: alt,
  };
}

function renderElement(el: AcElement): unknown[] {
  switch (el.type) {
    case "TextBlock":
      return [renderTextBlock(el)];
    case "FactSet":
      return renderFactSet(el);
    case "Image": {
      const block = renderImage(el);
      return block ? [block] : [];
    }
    case "ColumnSet": {
      const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
      if (!columns?.length) {
        return [];
      }
      return columns.flatMap((col) => (col.items ?? []).flatMap(renderElement));
    }
    case "Container": {
      const items = el.items as AcElement[] | undefined;
      return (items ?? []).flatMap(renderElement);
    }
    default:
      return [];
  }
}

type SlackButton = {
  type: "button";
  text: { type: "plain_text"; text: string };
  url?: string;
  action_id?: string;
  value?: string;
};

function renderActions(actions: unknown[]): unknown[] {
  const buttons: SlackButton[] = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = str(action.title);
    if (!label) {
      continue;
    }
    if (action.type === "Action.OpenUrl") {
      const url = str(action.url);
      if (!url) {
        continue; // skip: Slack rejects link buttons with an empty URL
      }
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: label },
        url,
      });
    } else if (action.type === "Action.Submit") {
      const actionId = typeof action.id === "string" ? action.id : `ac_submit_${buttons.length}`;
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: label },
        action_id: actionId,
        value: action.data != null ? JSON.stringify(action.data) : undefined,
      });
    }
  }
  if (buttons.length === 0) {
    return [];
  }
  return [{ type: "actions", elements: buttons }];
}

export const slackStrategy: CardRenderStrategy = {
  name: "slack",
  render(parsed: ParsedAdaptiveCard): CardRenderResult {
    const blocks: unknown[] = [];

    for (const el of parsed.card.body) {
      const rendered = renderElement(el as AcElement);
      if (rendered.length > 0) {
        // Add a divider between groups when we already have blocks
        if (blocks.length > 0) {
          blocks.push({ type: "divider" });
        }
        blocks.push(...rendered);
      }
    }

    if (parsed.card.actions?.length) {
      blocks.push(...renderActions(parsed.card.actions));
    }

    return {
      type: "slack",
      blocks,
      fallback: parsed.fallbackText,
    };
  },
};
