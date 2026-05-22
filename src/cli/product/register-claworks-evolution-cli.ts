import type { Command } from "commander";
import { isClaworksProduct } from "../../config/paths.js";

/** Register `claworks evolution` only when running as ClaWorks product. */
export async function registerClaworksEvolutionCliIfProduct(program: Command): Promise<void> {
  if (!isClaworksProduct()) {
    return;
  }
  const mod = await import("@claworks/runtime");
  mod.registerClaworksEvolutionCli(program);
}
