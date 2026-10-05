import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parsePackageOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { isMissingPathError } from "../errno.js";
import { readJson } from "../json-files.js";
import { resolveUpdateInstallRoot } from "../update-install-root.js";

export type UpgradeRecipeInventory = {
  root: string;
  observedVersion: string | null;
  declaredStateContracts?: { state: number; agent: number };
  identityClass: "unknown" | "verified-release" | "recognized-modified";
  releaseId?: string;
  installKind: "unknown" | "npm" | "pnpm" | "bun" | "git" | "immutable" | "external-owned";
  platform: { os: string; arch: string; serviceMode: string };
  runtimeFamily: "node" | "bun" | "unknown";
  stateContractClass?: string;
  recovery: "unknown" | "clear" | "active";
  serviceRoot?: string;
  issues: string[];
};

const manifestSchema = z.object({ name: z.literal("openclaw"), version: z.string().min(1) });

/** Never import the inspected package, execute its tools, or open live state databases. */
export async function inspectUpgradeRecipeInstallation(
  root: string,
): Promise<UpgradeRecipeInventory> {
  const inventory: UpgradeRecipeInventory = {
    root: resolveUpdateInstallRoot(root),
    observedVersion: null,
    identityClass: "unknown",
    installKind: "unknown",
    platform: { os: process.platform, arch: process.arch, serviceMode: "unknown" },
    runtimeFamily: process.versions.bun ? "bun" : "node",
    recovery: "unknown",
    issues: [],
  };
  try {
    const raw = await readJson<unknown>(path.join(inventory.root, "package.json"), {
      maxBytes: 1024 * 1024,
    });
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      inventory.issues.push("The installation manifest is not recognized OpenClaw metadata.");
    } else {
      inventory.observedVersion = parsed.data.version;
      inventory.declaredStateContracts = parsePackageOpenClawSchemaVersions(raw);
    }
  } catch {
    inventory.issues.push(
      "The installation manifest is missing, invalid, too large, or unreadable.",
    );
  }
  try {
    await fs.lstat(path.join(inventory.root, ".git"));
    inventory.installKind = "git";
    inventory.issues.push(
      "Git modifications, ignored files, worktrees, remotes, and local plugin links have not been verified.",
    );
  } catch (error) {
    if (!isMissingPathError(error)) {
      inventory.issues.push(
        "Git metadata inspection failed; installation ownership remains unknown.",
      );
    }
  }
  // Source packageManager and node_modules layout are not installation-owner evidence.
  return inventory;
}
