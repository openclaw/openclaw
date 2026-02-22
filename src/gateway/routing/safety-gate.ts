import type { RoutingConfig } from "./types.js";

export function checkSafety(
  text: string,
  config: RoutingConfig,
): { ok: true } | { ok: false; error: string } {
  const body = text ?? "";
  const hit = (config.deny_list ?? []).find(
    (term) => term && body.toLowerCase().includes(term.toLowerCase()),
  );
  if (hit) {
    return { ok: false, error: `matched deny_list: ${hit}` };
  }
  return { ok: true };
}
