// Shared "lobster day" calendar hash: the CLI banner's ASCII cousin and the
// Control UI pet coordinate wardrobe through this one function, so both
// surfaces always agree on the date. Roughly one day in sixteen hits.

import { fnv1aUtf16 } from "./fnv1a.js";

export function lobsterDayHash(now: Date): number {
  return fnv1aUtf16(`${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`);
}

export function isLobsterDay(now: Date): boolean {
  return lobsterDayHash(now) % 16 === 3;
}
