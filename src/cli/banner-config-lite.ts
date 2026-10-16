// Lightweight banner option parser kept out of the full CLI import path.
import type { TaglineMode } from "./tagline.js";

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}
