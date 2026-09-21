/** Doctor warnings for source checkout installs with missing pnpm runtime state. */
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatErrorMessage } from "../infra/errors.js";
import { reconcileWindowsGitLauncher } from "../infra/windows-git-launcher.js";

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

/** Detects self-referential `openclaw: link:` damage left by link commands run inside a source checkout. */
function detectSelfLinkWarnings(root: string): string[] {
  const warnings: string[] = [];

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      // SAFETY: JSON.parse of a package.json file yields an object with optional dependency maps.
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const selfLink = [manifest.dependencies, manifest.devDependencies].some((deps) =>
        isSelfLink(root, deps?.openclaw),
      );
      if (selfLink) {
        warnings.push(
          `- package.json has a self-referential "openclaw": "link:" dependency, which can break frozen pnpm installs. If the link is unintended: ${SELF_LINK_RECOVERY}`,
        );
      }
    } catch {
      // Unparseable package.json is reported by other checks; skip link detection.
    }
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

/** Migrates the installer-owned Windows Git launcher through Doctor/update repair. */
export async function repairWindowsGitLauncher(root: string | null, shouldRepair: boolean) {
  if (!root) {
    return;
  }
  let result: Awaited<ReturnType<typeof reconcileWindowsGitLauncher>>;
  try {
    result = await reconcileWindowsGitLauncher({ root, repair: shouldRepair });
  } catch (error) {
    // Launcher maintenance is advisory in Doctor, including its post-update path.
    // The install command still calls the reconciler directly and fails publication.
    note(
      `- Windows Git launcher maintenance could not finish: ${formatErrorMessage(error)}. Check launcher permissions and re-run the OpenClaw installer to repair it. Other Doctor checks will continue.`,
      "Install",
    );
    return;
  }
  if (result.status === "needs-repair") {
    note(
      `- ${result.launcherPath} does not use the current validated Node runtime. Run: openclaw doctor --fix`,
      "Install",
    );
  } else if (result.status === "needs-reinstall") {
    note(
      `- ${result.launcherPath} cannot be safely migrated from the current Node runtime. Re-run the OpenClaw installer.`,
      "Install",
    );
  } else if (result.status === "updated") {
    note(`- Updated ${result.launcherPath} to use the validated Node runtime.`, "Install");
  }
}
