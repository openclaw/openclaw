/**
 * Mail buttons hook handler
 *
 * Automatically adds interactive Gmail action buttons to outbound messages
 * containing mail thread IDs.
 */

import type { OpenClawConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { InternalHookHandler } from "../../hooks.js";
import type { InteractiveReply } from "../../../interactive/payload.js";

const log = createSubsystemLogger("hooks/mail-buttons");

// Gmail thread ID regex (16 hex chars)
const THREAD_ID_REGEX = /\b([a-f0-9]{16})\b/g;

/**
 * Automatically add interactive Gmail action buttons to outbound messages
 */
const addMailButtons: InternalHookHandler = async (event) => {
  // Only trigger on message:sending event
  if (event.type !== "message" || event.action !== "sending") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const content = context.content as string | undefined;

    if (!content) {
      return;
    }

    // Read hook config
    const hookConfig = resolveHookConfig(cfg, "mail-buttons");
    if (hookConfig?.enabled === false) {
      return;
    }

    // Find thread IDs in content
    const threadIds = [...content.matchAll(THREAD_ID_REGEX)].map((m) => m[1]);
    if (threadIds.length === 0) {
      return;
    }

    // Use the first thread ID for buttons (simplification for now)
    const threadId = threadIds[0];
    log.debug("Detected Gmail thread ID, injecting buttons", { threadId });

    // Get buttons from config or use defaults
    const configuredButtons = (hookConfig?.buttons as any[]) || [
      { text: "📥 Archive", action: "archive" },
      { text: "✏️ Reply", action: "reply" },
      { text: "🗑 Delete", action: "delete" }
    ];

    const buttons = configuredButtons.map((btn) => {
      let callbackData = `mb:${btn.action}:${threadId}`;
      if (btn.action === "label" && btn.label) {
        callbackData = `mb:label:${btn.label}:${threadId}`;
      }
      return {
        text: btn.text,
        callback_data: callbackData
      };
    });

    // Inject buttons into the event context
    // The outbound pipeline will pick these up from context.interactive
    const interactive: InteractiveReply = {
      blocks: [
        {
          type: "buttons",
          buttons: buttons as any
        }
      ]
    };

    // Modify the event context in-place
    event.context.interactive = interactive;

  } catch (err) {
    log.error("Failed to add mail buttons", { error: String(err) });
  }
};

export default addMailButtons;
