import fs from "node:fs/promises";
import path from "node:path";
import { readBestEffortConfig } from "../config/config.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { exportSetupSurface } from "../setup/surface-export.js";
import type { SetupSurfaceSection } from "../setup/surface-types.js";

function normalizeSections(rawSections: string[]): SetupSurfaceSection[] {
  const normalized = rawSections.map((value) => value.trim().toLowerCase()).filter(Boolean);

  const sections = normalized.length === 0 ? ["providers", "channels"] : normalized;
  const invalid = sections.filter((value) => value !== "providers" && value !== "channels");
  if (invalid.length > 0) {
    throw new Error(`Unsupported --section value(s): ${invalid.join(", ")}`);
  }
  return [...new Set(sections)] as SetupSurfaceSection[];
}

export async function configureSurfaceCommand(params: {
  jsonOut: string;
  section: string[];
  installedOnly?: boolean;
  runtime: OutputRuntimeEnv;
}): Promise<void> {
  const outputPath = params.jsonOut.trim();
  if (!outputPath) {
    throw new Error("--json-out is required");
  }

  const cfg = await readBestEffortConfig();
  const surface = await exportSetupSurface({
    config: cfg,
    sections: normalizeSections(params.section),
    ...(params.installedOnly ? { installedOnly: true } : {}),
  });

  const resolvedOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(resolvedOutputPath, `${JSON.stringify(surface, null, 2)}\n`, "utf8");
  params.runtime.writeStdout(resolvedOutputPath);
}
