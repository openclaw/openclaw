/**
 * Mail buttons hook handler
 *
 * Automatically adds interactive Gmail action buttons to outbound messages
 * containing mail thread IDs.
 */

import type { OpenClawConfig } from "../../../config/config.js";
import type { InteractiveReply, InteractiveReplyButton } from "../../../interactive/payload.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { InternalHookHandler } from "../../hooks.js";
import { isMessageSendingEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/mail-buttons");
const HOOK_KEY = "mail-buttons";

/** Gmail thread ID: exactly 16 lowercase hex characters */
const THREAD_ID_REGEX = /\b([a-f0-9]{16})\b/g;

type ButtonConfig = {
  text: string;
  action: string;
  label?: string;
};

const DEFAULT_BUTTONS: ButtonConfig[] = [{ text: "➡️ Next", action: "next" }];

function buildCallbackData(btn: ButtonConfig, threadId: string): string {
  if (btn.action === "label" && btn.label) {
    return `mb:label:${btn.label}:${threadId}`;
  }
  return `mb:${btn.action}:${threadId}`;
}

function buildButtons(
  configuredButtons: ButtonConfig[],
  threadId: string,
): InteractiveReplyButton[] {
  return configuredButtons.map((btn) => ({
    label: btn.text,
    value: buildCallbackData(btn, threadId),
  }));
}

function extractThreadIds(content: string): string[] {
  return [...content.matchAll(THREAD_ID_REGEX)].map((m) => m[1]);
}

/**
 * Automatically add interactive Gmail action buttons to outbound messages
 * that contain a Gmail thread ID.
 */
const addMailButtons: InternalHookHandler = async (event) => {
  if (!isMessageSendingEvent(event)) {
    return;
  }

  try {
    const { content, cfg } = event.context;

    if (!content) {
      return;
    }

    // Read hook config — disabled by default if config missing
    const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
    if (!hookConfig || hookConfig.enabled === false) {
      return;
    }

    const threadIds = extractThreadIds(content);
    if (threadIds.length === 0) {
      return;
    }

    // Use the first detected thread ID
    const threadId = threadIds[0];
    log.debug("Detected Gmail thread ID, injecting buttons", { threadId });

    const configuredButtons =
      (hookConfig?.buttons as ButtonConfig[] | undefined) ?? DEFAULT_BUTTONS;
    const buttons = buildButtons(configuredButtons, threadId);

    const interactive: InteractiveReply = {
      blocks: [{ type: "buttons", buttons }],
    };

    // Mutate context in-place — the deliver pipeline reads this after the hook fires
    event.context.interactive = interactive;
  } catch (err) {
    log.error("Failed to add mail buttons", { error: String(err) });
    // Never block delivery on hook failure
  }
};

export default addMailButtons;
