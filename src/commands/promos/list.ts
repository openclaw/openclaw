import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { ClawHubRequestError } from "../../infra/clawhub-client.js";
import { fetchClawHubPromotions, type ClawHubPromotion } from "../../infra/clawhub-promotions.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export async function promosListCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  let promotions: ClawHubPromotion[];
  try {
    promotions = await fetchClawHubPromotions();
  } catch (error) {
    if (!(error instanceof ClawHubRequestError) || error.status !== 404) {
      throw error;
    }
    if (opts.json) {
      writeRuntimeJson(runtime, { promotions: [] });
    } else {
      runtime.log("Promotions are not available from ClawHub yet.");
    }
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { promotions });
    return;
  }
  if (promotions.length === 0) {
    runtime.log("No active promotions right now.");
    return;
  }
  // Promotion text is remote content; strip control sequences before it can
  // reach an interactive terminal.
  const safe = sanitizeTerminalText;
  for (const promotion of promotions) {
    const sponsor = promotion.sponsor ? ` — ${safe(promotion.sponsor)}` : "";
    const title = safe(promotion.title);
    const remainingMs = promotion.endsAt - Date.now();
    const daysLeft = Math.floor(remainingMs / 86_400_000);
    const timeLeft =
      daysLeft < 1
        ? formatDurationCompact(remainingMs, { spaced: true })
        : daysLeft === 1
          ? "1 day"
          : `${daysLeft} days`;
    runtime.log(`${title}${sponsor} (${timeLeft ? `${timeLeft} left` : "ended"})`);
    runtime.log(`  ${safe(promotion.blurb)}`);
    for (const model of promotion.models) {
      const alias = model.alias ? ` (${safe(model.alias)})` : "";
      const suggested = model.suggestedDefault ? " — suggested default" : "";
      runtime.log(`  · ${safe(model.modelRef)}${alias}${suggested}`);
    }
    runtime.log(`  Claim: ${formatCliCommand(`openclaw promos claim ${safe(promotion.slug)}`)}`);
  }
}
