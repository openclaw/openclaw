/** Lists active ClawHub promotional model offers. */
import { formatCliCommand } from "../../cli/command-format.js";
import { fetchClawHubPromotions, type ClawHubPromotion } from "../../infra/clawhub.js";
import type { RuntimeEnv } from "../../runtime.js";

function formatWindowEnd(promotion: ClawHubPromotion): string {
  const daysLeft = Math.max(0, Math.ceil((promotion.endsAt - Date.now()) / 86_400_000));
  if (daysLeft === 0) {
    return "ends today";
  }
  return daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
}

export async function promosListCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const promotions = await fetchClawHubPromotions();
  if (opts.json) {
    runtime.log(JSON.stringify({ promotions }, null, 2));
    return;
  }
  if (promotions.length === 0) {
    runtime.log("No active promotions right now.");
    return;
  }
  for (const promotion of promotions) {
    const sponsor = promotion.sponsor ? ` — ${promotion.sponsor}` : "";
    runtime.log(`${promotion.title}${sponsor} (${formatWindowEnd(promotion)})`);
    runtime.log(`  ${promotion.blurb}`);
    for (const model of promotion.models) {
      const alias = model.alias ? ` (${model.alias})` : "";
      const suggested = model.suggestedDefault ? " — suggested default" : "";
      runtime.log(`  · ${model.modelRef}${alias}${suggested}`);
    }
    runtime.log(`  Claim: ${formatCliCommand(`openclaw promos claim ${promotion.slug}`)}`);
  }
}
