import fs from "node:fs";
import { discoverPackSourceDir, repairClaworksJsonConfig } from "@claworks/runtime";
import type { DoctorOptions } from "../../commands/doctor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { productizeUserCopy } from "../product-surface.js";

export async function runClaworksProductDoctorHealth(ctx: {
  configPath: string;
  options: DoctorOptions;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { note } = await import("../../terminal/note.js");
  const { detectClaworksProductHealthFindings } =
    await import("../../flows/claworks-product-health-checks.js");
  const lines: string[] = [];

  if (!fs.existsSync(ctx.configPath)) {
    note(
      [
        `ClaWorks config missing: ${ctx.configPath}`,
        "Fix: pnpm claworks:start  (auto-init) or pnpm claworks:init",
      ].join("\n"),
      "ClaWorks",
    );
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(ctx.configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    note(`Invalid ClaWorks JSON: ${err instanceof Error ? err.message : String(err)}`, "ClaWorks");
    return;
  }

  const isolationFindings = await detectClaworksProductHealthFindings({
    mode: "doctor",
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    configPath: ctx.configPath,
  });
  for (const finding of isolationFindings) {
    const prefix = finding.severity === "error" ? "✗" : finding.severity === "warning" ? "⚠" : "•";
    lines.push(`${prefix} ${productizeUserCopy(finding.message)}`);
    if (finding.fixHint) {
      lines.push(`  Fix: ${productizeUserCopy(finding.fixHint)}`);
    }
  }

  const entry = (config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined)
    ?.entries?.["claworks-robot"];
  if (!entry || entry.enabled === false) {
    lines.push("plugins.entries.claworks-robot is missing or disabled.");
  }

  const robotConfig = (entry as { config?: { packs?: { installed?: string[] } } } | undefined)
    ?.config;
  const installed = robotConfig?.packs?.installed ?? [];
  if (installed.length === 0) {
    lines.push("No packs.installed — playbooks and object types will not load.");
  }

  const packSource = discoverPackSourceDir();
  if (!packSource) {
    lines.push(
      "claworks-packs source not found — set CLAWORKS_PACKS_DIR or clone ../claworks-packs.",
    );
  } else {
    lines.push(`Pack source: ${packSource}`);
  }

  if (ctx.options.repair === true || ctx.options.yes === true) {
    const repair = repairClaworksJsonConfig(config, {
      packSourceDir: packSource,
      seedRobotMd: true,
    });
    if (repair.changed) {
      fs.writeFileSync(ctx.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      lines.push("Applied config repair:");
      lines.push(...repair.actions.map((a) => `  • ${a}`));
    }
    if (repair.warnings.length > 0) {
      lines.push(...repair.warnings.map((w) => `  ⚠ ${w}`));
    }
  } else {
    lines.push(
      "Run: pnpm claworks:repair  (or claworks doctor --fix / claworks start) to enable robot + packs.",
    );
  }

  note(lines.join("\n"), "ClaWorks");
}
