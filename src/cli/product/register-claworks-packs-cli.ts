import type { Command } from "commander";
import { isClaworksProduct } from "../../config/paths.js";

/** Register `openclaw packs` only when running as ClaWorks product (keeps upstream core decoupled). */
export async function registerClaworksPacksCliIfProduct(program: Command): Promise<void> {
  if (!isClaworksProduct()) {
    return;
  }
  const mod = await import("@claworks/runtime");
  mod.registerClaworksPacksCli(program);
}
