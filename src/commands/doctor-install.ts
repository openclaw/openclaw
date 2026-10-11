import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument } from "yaml";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";

export async function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }
  const installOwner = await readInstallOwner(root);
  if (installOwner) {
    note(formatInstallOwnerMessage(installOwner), "Install");
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
  for (const [filename, description] of [
    ["package.json", 'has a self-referential "openclaw": "link:" dependency'],
    ["pnpm-workspace.yaml", 'contains a self-referential "openclaw: link:" entry'],
  ] as const) {
    try {
      const source = fs.readFileSync(path.join(root, filename), "utf8");
      let links: unknown[];
      if (filename === "package.json") {
        const manifest = asOptionalRecord(JSON.parse(source));
        links = [manifest?.dependencies, manifest?.devDependencies].map(
          (deps) => asOptionalRecord(deps)?.openclaw,
        );
      } else {
        const workspace = parseDocument(source);
        links = workspace.errors.length === 0 ? [workspace.toJS()?.overrides?.openclaw] : [];
      }
      if (links.some((link) => isSelfLink(root, link))) {
        warnings.push(
          `- ${filename} ${description}, which can break frozen pnpm installs. If the link is unintended: ${SELF_LINK_RECOVERY}`,
        );
      }
    } catch {
      // Unreadable or malformed files must not abort the remaining install checks.
    }
  }
  return warnings;
}
