/** Doctor warnings for source checkout installs with missing pnpm runtime state. */
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument } from "yaml";
import { note } from "../../packages/terminal-core/src/note.js";

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

  if (!fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install.");
  }

  warnings.push(...detectSelfLinkWarnings(root));

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

const SELF_LINK_RECOVERY =
  "Inspect the diff: git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml. Selectively restore the damaged dependency and override entries (including any missing override pins) and matching lockfile changes from a known-good revision, preserving unrelated edits in all three files. Then verify recovery: pnpm install --frozen-lockfile. Never run pnpm link/npm link inside a deployment checkout.";

function isSelfLink(root: string, value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("link:")) {
    return false;
  }
  const target = path.resolve(root, value.slice("link:".length));
  try {
    return fs.realpathSync(target) === fs.realpathSync(root);
  } catch {
    return target === path.resolve(root);
  }
}

function detectSelfLinkWarnings(root: string): string[] {
  const warnings: string[] = [];

  const packageJsonPath = path.join(root, "package.json");
  try {
    const manifest = asOptionalRecord(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")));
    const selfLink = [manifest?.dependencies, manifest?.devDependencies].some((deps) =>
      isSelfLink(root, asOptionalRecord(deps)?.openclaw),
    );
    if (selfLink) {
      warnings.push(
        `- package.json has a self-referential "openclaw": "link:" dependency, which can break frozen pnpm installs. If the link is unintended: ${SELF_LINK_RECOVERY}`,
      );
    }
  } catch {
    // Missing or unparseable package.json is reported by other checks.
  }

  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  try {
    const workspace = parseDocument(fs.readFileSync(workspacePath, "utf8"));
    const selfLink = workspace.errors.length === 0 && workspace.toJS()?.overrides?.openclaw;
    if (isSelfLink(root, selfLink)) {
      warnings.push(
        `- pnpm-workspace.yaml contains a self-referential "openclaw: link:" entry, which can break frozen pnpm installs. If the link is unintended: ${SELF_LINK_RECOVERY}`,
      );
    }
  } catch {
    // A malformed or unreadable workspace file must not abort the remaining Doctor checks.
  }

  return warnings;
}
