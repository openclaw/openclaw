/**
 * Message filter hook handler
 *
 * Filters out automated/junk inbound messages (OTP codes, marketing,
 * appointment reminders, etc.) so the AI agent doesn't respond to them.
 *
 * Opt-in only: requires `enabled: true` in hook config.
 * Never filters messages starting with "/" (command bypass).
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { InboundMessageHookContext } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/message-filter");

type CategoryPatterns = Record<string, RegExp[]>;

const BUILTIN_CATEGORIES: CategoryPatterns = {
  otp: [
    /\bverification code\b/i,
    /\bverify.{0,20}code\b/i,
    /\b(?:your|the)\s+code\s+is\b/i,
    /\b(?:one[- ]?time|otp)\s*(?:pass)?(?:code|password)\b/i,
    /\b2fa\b/i,
    /\bsecurity code\b/i,
    /\b\d{4,8}\b.*\b(?:expires?|valid)\b/i,
    /\benter\s+(?:this\s+)?code\b/i,
    /\bpin\s*(?:is|:)\s*\d{4,8}\b/i,
  ],
  marketing: [
    /\breply\s+stop\b/i,
    /\btext\s+stop\b/i,
    /\bunsubscribe\b/i,
    /\bopt[ -]?out\b/i,
    /\b\d+%\s*off\b/i,
    /\bcoupon\b/i,
    /\bpromo(?:tion(?:al)?)?\s*code\b/i,
    /\blimited[- ]time\s+offer\b/i,
    /\bfree\s+(?:shipping|trial|gift)\b/i,
    /\bexclusive\s+(?:deal|offer|discount)\b/i,
    /\bact\s+now\b/i,
    /\bdon'?t\s+miss\s+(?:out|this)\b/i,
    /\bshop\s+now\b/i,
    /\bbuy\s+now\b/i,
    /\border\s+(?:now|today)\b/i,
    /\bsale\s+(?:ends?|starts?)\b/i,
    /\buse\s+code\b/i,
  ],
  appointments: [
    /\b(?:appointment|appt)\.?\s+(?:with|at|on|for)\b/i,
    /\b(?:appointment|appt)\b.{0,30}\b(?:reserved|scheduled|confirmed|booked)\b/i,
    /\byou have\s+(?:a|an)\s+(?:appointment|appt)\b/i,
    /\breminder:\s*(?:your\s+)?(?:appointment|visit)\b/i,
    /\b(?:doctor|dr|dentist\w*|physician|orthodont\w*)\b.*\b(?:appointment|tomorrow|today)\b/i,
    /\b(?:appointment|appt)\b.*\b(?:dentist\w*|doctor|dr\.|physician|clinic|medical|dental)\b/i,
    /\b(?:confirm|cancel)\s+(?:your\s+)?(?:appointment|visit)\b/i,
    /\breply\s+(?:yes|y|c|1)\s+to\s+confirm\b/i,
    /\bscheduled\s+(?:for|on|at)\b/i,
  ],
  fitness: [
    /\bgym\s+class\b/i,
    /\bworkout\s+(?:reminder|starts|session)\b/i,
    /\byour\s+(?:class|session)\s+(?:starts?|begins?)\b/i,
    /\b(?:fitness|yoga|pilates|spin|cycling)\s+class\b/i,
    /\bclass\s+(?:starts?|begins?)\s+in\b/i,
  ],
  delivery: [
    /\bpackage\s+(?:has\s+been\s+)?(?:shipped|delivered|out for delivery)\b/i,
    /\btracking\s+(?:number|#|info)\b/i,
    /\byour\s+(?:order|delivery)\s+(?:has|is|will)\b/i,
    /\b(?:ups|fedex|usps|dhl)\b.*\b(?:tracking|delivery|shipped)\b/i,
    /\bestimated\s+delivery\b/i,
    /\bout\s+for\s+delivery\b/i,
  ],
  banking: [
    /\btransaction\s+(?:alert|notification)\b/i,
    /\baccount\s+(?:balance|ending)\b/i,
    /\bpurchase\s+(?:of|for)\s+\$?\d/i,
    /\b(?:debit|credit)\s+card\b.*\b(?:used|charged|transaction)\b/i,
    /\bavailable\s+balance\b/i,
    /\bdirect\s+deposit\b/i,
    /\bfraud\s+alert\b/i,
    /\bsuspicious\s+(?:activity|transaction)\b/i,
  ],
};

type MessageFilterConfig = {
  enabled?: boolean;
  categories?: Record<string, boolean>;
  customPatterns?: string[];
  blockedSenders?: string[];
  allowedSenders?: string[];
  filterShortcodes?: boolean;
  logBody?: boolean;
};

/** SMS shortcodes are 5-6 digit numbers used by automated systems */
const SHORTCODE_RE = /^\d{4,6}$/;

function redactDigits(text: string): string {
  return text.replace(/\d/g, "*");
}

const messageFilter: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "inbound") {
    return;
  }

  const context = event.context as unknown as InboundMessageHookContext;
  if (!context || typeof context.bodyForCommands !== "string") {
    return;
  }

  const cfg = context.cfg;
  const hookConfig = resolveHookConfig(cfg, "message-filter") as MessageFilterConfig | undefined;

  // Opt-in only: do nothing if not explicitly enabled
  if (!hookConfig?.enabled) {
    return;
  }

  const body = context.bodyForCommands.trim();

  // Command bypass: never filter messages starting with /
  if (body.startsWith("/")) {
    return;
  }

  // Allowed senders bypass
  const allowedSenders = hookConfig.allowedSenders ?? [];
  if (allowedSenders.length > 0 && allowedSenders.includes(context.senderId)) {
    return;
  }

  // Blocked senders: always filter
  const blockedSenders = hookConfig.blockedSenders ?? [];
  if (blockedSenders.length > 0 && blockedSenders.includes(context.senderId)) {
    context.skip = true;
    context.skipReason = "message-filter:blocked-sender";
    log.debug("Message filtered", {
      channel: context.channel,
      senderId: context.senderId,
      messageId: context.messageId,
      skipReason: context.skipReason,
    });
    return;
  }

  // Shortcode senders (5-6 digit numbers like "74640") are automated systems
  if (hookConfig.filterShortcodes !== false && SHORTCODE_RE.test(context.senderId)) {
    context.skip = true;
    context.skipReason = "message-filter:shortcode";
    log.debug("Message filtered", {
      channel: context.channel,
      senderId: context.senderId,
      messageId: context.messageId,
      skipReason: context.skipReason,
    });
    return;
  }

  // Check built-in categories
  const categoryConfig = hookConfig.categories ?? {};
  for (const [category, patterns] of Object.entries(BUILTIN_CATEGORIES)) {
    // Skip explicitly disabled categories (all enabled by default when not mentioned)
    if (categoryConfig[category] !== undefined && !categoryConfig[category]) {
      continue;
    }

    for (const pattern of patterns) {
      if (pattern.test(body)) {
        context.skip = true;
        context.skipReason = `message-filter:${category}`;
        const logMeta: Record<string, unknown> = {
          channel: context.channel,
          senderId: context.senderId,
          messageId: context.messageId,
          skipReason: context.skipReason,
        };
        if (hookConfig.logBody === true) {
          logMeta.body = redactDigits(body);
        }
        log.debug("Message filtered", logMeta);
        return;
      }
    }
  }

  // Check custom patterns
  const customPatterns = hookConfig.customPatterns ?? [];
  for (const patternStr of customPatterns) {
    try {
      const re = new RegExp(patternStr, "i");
      if (re.test(body)) {
        context.skip = true;
        context.skipReason = "message-filter:custom";
        const logMeta: Record<string, unknown> = {
          channel: context.channel,
          senderId: context.senderId,
          messageId: context.messageId,
          skipReason: context.skipReason,
        };
        if (hookConfig.logBody === true) {
          logMeta.body = redactDigits(body);
        }
        log.debug("Message filtered", logMeta);
        return;
      }
    } catch {
      log.warn(`Invalid custom pattern: ${patternStr}`);
    }
  }
};

export default messageFilter;
