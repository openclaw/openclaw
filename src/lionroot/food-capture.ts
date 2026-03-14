import fs from "node:fs/promises";
import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { MediaAttachmentCache } from "../media-understanding/attachments.cache.js";
import { buildMediaUnderstandingRegistry } from "../media-understanding/providers/index.js";
import { runCapability } from "../media-understanding/runner.js";
import type { MediaAttachment } from "../media-understanding/types.js";

export type FoodCaptureMeal = "coffee" | "breakfast" | "lunch" | "dinner" | "snack" | "other";

const FOODY_TEXT_RE =
  /\b(food|meal|breakfast|lunch|dinner|snack|coffee|drink|smoothie|protein shake|supplement|vitamin)\b/i;
const FOODY_DESCRIPTION_RE =
  /\b(food|meal|dish|plate|bowl|coffee|drink|beverage|breakfast|lunch|dinner|snack|salad|sandwich|burger|pizza|rice|eggs|steak|chicken|fruit|smoothie|protein shake|supplement|vitamin|pill bottle|capsule)\b/i;
const NON_FOOD_DESCRIPTION_RE =
  /\b(screenshot|screen|document|text message|code|chart|graph|website|app|ui|meme|poster|logo|selfie|person|room|car|dog|cat)\b/i;

function isImageMediaType(mediaType?: string): boolean {
  return (mediaType || "").toLowerCase().startsWith("image/");
}

function looksLikePlaceholder(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  return !trimmed || /^<media:[^>]+>$/.test(trimmed);
}

function inferMeal(bodyText: string): FoodCaptureMeal {
  const normalized = bodyText.toLowerCase();
  if (/\bcoffee\b/.test(normalized)) {
    return "coffee";
  }
  if (/\bbreakfast\b/.test(normalized)) {
    return "breakfast";
  }
  if (/\blunch\b/.test(normalized)) {
    return "lunch";
  }
  if (/\bdinner\b/.test(normalized)) {
    return "dinner";
  }
  if (/\bsnack\b/.test(normalized)) {
    return "snack";
  }
  return "other";
}

function buildCaptureNote(bodyText: string, description: string | null): string | undefined {
  const parts = [
    looksLikePlaceholder(bodyText) ? null : bodyText.trim(),
    description?.trim() || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

function isLikelyFoodCapture(params: { bodyText: string; description: string | null }): boolean {
  if (FOODY_TEXT_RE.test(params.bodyText)) {
    return true;
  }
  if (!params.description) {
    return false;
  }
  const normalized = params.description.toLowerCase();
  if (NON_FOOD_DESCRIPTION_RE.test(normalized) && !FOODY_DESCRIPTION_RE.test(normalized)) {
    return false;
  }
  return FOODY_DESCRIPTION_RE.test(normalized);
}

export async function describeFoodCaptureImage(params: {
  cfg: OpenClawConfig;
  bodyText: string;
  mediaPath: string;
  mediaType?: string;
  accountId: string;
  sender: string;
  isGroup: boolean;
}): Promise<string | null> {
  const media: MediaAttachment[] = [
    {
      index: 0,
      path: params.mediaPath,
      mime: params.mediaType,
    },
  ];
  const ctx: MsgContext = {
    Body: params.bodyText,
    RawBody: params.bodyText,
    BodyForCommands: params.bodyText,
    AccountId: params.accountId,
    Provider: "imessage",
    Surface: "imessage",
    ChatType: params.isGroup ? "group" : "direct",
    SenderE164: params.sender,
    MediaPath: params.mediaPath,
    MediaType: params.mediaType,
    MediaPaths: [params.mediaPath],
    MediaTypes: params.mediaType ? [params.mediaType] : [],
  };
  const cache = new MediaAttachmentCache(media);
  const result = await runCapability({
    capability: "image",
    cfg: params.cfg,
    ctx,
    attachments: cache,
    media,
    providerRegistry: buildMediaUnderstandingRegistry(),
  });
  return result.outputs.find((entry) => entry.kind === "image.description")?.text?.trim() || null;
}

export async function maybeHandleFoodImageCapture(params: {
  cfg: OpenClawConfig;
  bodyText: string;
  mediaPath?: string;
  mediaType?: string;
  sender: string;
  accountId: string;
  isGroup: boolean;
  sendMessage: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  sendOptions?: Record<string, unknown>;
}): Promise<boolean> {
  const endpoint = process.env.LIONROOT_FOOD_CAPTURE_URL?.trim();
  const token = process.env.LIONROOT_FOOD_CAPTURE_TOKEN?.trim();
  const expectedAccountId =
    process.env.LIONROOT_FOOD_CAPTURE_IMESSAGE_ACCOUNT_ID?.trim() || "lionheart";

  if (!endpoint || !token || !params.mediaPath || !isImageMediaType(params.mediaType)) {
    return false;
  }
  if (params.accountId !== expectedAccountId) {
    return false;
  }

  let description: string | null = null;
  try {
    description = await describeFoodCaptureImage({
      cfg: params.cfg,
      bodyText: params.bodyText,
      mediaPath: params.mediaPath,
      mediaType: params.mediaType,
      accountId: params.accountId,
      sender: params.sender,
      isGroup: params.isGroup,
    });
  } catch (error) {
    logVerbose(`food-capture: image description failed: ${String(error)}`);
  }

  if (!isLikelyFoodCapture({ bodyText: params.bodyText, description })) {
    return false;
  }

  const fileBuffer = await fs.readFile(params.mediaPath);
  const form = new FormData();
  form.set(
    "image",
    new File([fileBuffer], path.basename(params.mediaPath), {
      type: params.mediaType || "application/octet-stream",
    }),
  );
  form.set("meal", inferMeal(params.bodyText));
  if (description || !looksLikePlaceholder(params.bodyText)) {
    form.set("note", buildCaptureNote(params.bodyText, description) || "");
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logVerbose(`food-capture: endpoint returned ${response.status}`);
      await params.sendMessage(
        params.sender,
        "⚠️ Could not add that to today's food log. Try again in a bit.",
        params.sendOptions,
      );
      return true;
    }
  } catch (error) {
    logVerbose(`food-capture: upload failed: ${String(error)}`);
    await params.sendMessage(
      params.sender,
      "⚠️ Could not add that to today's food log. Try again in a bit.",
      params.sendOptions,
    );
    return true;
  }

  await params.sendMessage(
    params.sender,
    "✓ Added to today's food log in Command Post.",
    params.sendOptions,
  );
  return true;
}
