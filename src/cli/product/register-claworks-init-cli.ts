import type { Command } from "commander";
import { isClaworksProduct } from "../../config/paths.js";

/** Register `claworks init` only when running as ClaWorks product. */
export async function registerClaworksInitCliIfProduct(program: Command): Promise<void> {
  if (!isClaworksProduct()) {
    return;
  }
  const mod = await import("@claworks/runtime");
  mod.registerClaworksInitCli(program);
}
