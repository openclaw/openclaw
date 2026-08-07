/** Doctor warnings for source checkout installs with missing pnpm runtime state. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml } from "yaml";
import { note } from "../../packages/terminal-core/src/note.js";

/** Emits install warnings when a source checkout looks npm-installed or lacks source-run deps. */
export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const srcEntry = path.join(root, "src", "entry.ts");
  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker) || !fs.existsSync(srcEntry)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install.");
  }

  const selfLinkLocations = detectSelfLinkLocations(root);
  if (selfLinkLocations.length > 0) {
    warnings.push(
      `- Source checkout dependency state contains a self-referential OpenClaw link in ${selfLinkLocations.join(", ")}. ` +
        "Inspect package.json, pnpm-workspace.yaml, and pnpm-lock.yaml. " +
        "For a clean deployment checkout, restore all three from the current commit: git restore --source=HEAD -- package.json pnpm-workspace.yaml pnpm-lock.yaml; then run: pnpm install --frozen-lockfile. " +
        "If the checkout has intentional dependency edits, remove only the self-link and run pnpm install to reconcile all three files. " +
        "Never run pnpm link or npm link inside a deployment checkout.",
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** Detects self-referential `openclaw: link:` damage left by link commands run inside a source checkout. */
function detectSelfLinkLocations(root: string): string[] {
  const locations: string[] = [];

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
      if (isRecord(manifest)) {
        for (const field of PACKAGE_DEPENDENCY_FIELDS) {
          const dependencies = manifest[field];
          if (
            isRecord(dependencies) &&
            typeof dependencies.openclaw === "string" &&
            dependencies.openclaw.startsWith("link:")
          ) {
            locations.push(`package.json ${field}`);
          }
        }
      }
    } catch {
      // Unparseable package.json is reported by other checks; skip link detection.
    }
  }

  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(workspacePath)) {
    try {
      const workspace = parseYaml(fs.readFileSync(workspacePath, "utf8")) as unknown;
      const overrides = isRecord(workspace) ? workspace.overrides : undefined;
      if (
        isRecord(overrides) &&
        typeof overrides.openclaw === "string" &&
        overrides.openclaw.startsWith("link:")
      ) {
        locations.push("pnpm-workspace.yaml overrides");
      }
    } catch {
      // Unparseable workspace YAML is reported by pnpm; skip link detection.
    }
  }

  return locations;
}
