/**
 * Migration tool for message-logger
 *
 * Renames old numbered folders (phone-number-based) to named slugs
 * when contacts-map.json is updated with contact names.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import { getContactsMap, resolveOutputDir, slugifyContact } from "./handler.js";

const log = createSubsystemLogger("hooks/message-logger/migrate");

export type MigrationResult = {
  from: string;
  to: string;
  merged: boolean;
};

export async function migrateNumberedFolders(opts?: {
  dryRun?: boolean;
}): Promise<MigrationResult[]> {
  const cfg = loadConfig();
  const cfgRec = cfg as unknown as Record<string, unknown>;
  const hookConfig = resolveHookConfig(cfg, "message-logger");

  const outputDir = resolveOutputDir(hookConfig as Record<string, unknown> | undefined, cfgRec);
  if (!outputDir) {
    log.error("No output dir resolved, cannot migrate");
    return [];
  }

  const contactsMap = getContactsMap(cfgRec);
  if (contactsMap.size === 0) {
    log.error("contacts-map.json is empty or not found, cannot migrate");
    return [];
  }

  const results: MigrationResult[] = [];

  let entries: string[];
  try {
    entries = await fs.promises.readdir(outputDir);
  } catch {
    log.error(`Cannot read output dir: ${outputDir}`);
    return [];
  }

  for (const entry of entries) {
    const fullPath = path.join(outputDir, entry);
    const stat = await fs.promises.stat(fullPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    // Only process folders that look like phone numbers (10-15 digits)
    if (!/^\d{10,15}$/.test(entry)) continue;

    const name = contactsMap.get(entry);
    if (!name) {
      log.debug(`No contact found for folder ${entry}, skipping`);
      continue;
    }

    const targetSlug = slugifyContact(name);
    const targetPath = path.join(outputDir, targetSlug);

    if (fullPath === targetPath) continue;

    const targetExists = await fs.promises.stat(targetPath).catch(() => null);
    const merged = !!targetExists?.isDirectory();

    if (opts?.dryRun) {
      log.info(`[DRY RUN] Would ${merged ? "merge" : "rename"}: ${entry} -> ${targetSlug}`);
      results.push({ from: entry, to: targetSlug, merged });
      continue;
    }

    if (merged) {
      // Merge: move files from source into existing target
      const files = await fs.promises.readdir(fullPath);
      for (const file of files) {
        if (file === "media") continue;
        const srcFile = path.join(fullPath, file);
        const destFile = path.join(targetPath, file);
        const srcStat = await fs.promises.stat(srcFile).catch(() => null);
        if (!srcStat?.isFile()) continue;

        const destExists = await fs.promises.stat(destFile).catch(() => null);
        if (destExists) {
          const srcContent = await fs.promises.readFile(srcFile, "utf-8");
          // Strip header lines (# Chat: ... and ## date) to avoid duplicates when merging
          const lines = srcContent.split("\n");
          const firstDateIdx = lines.findIndex((l) => l.startsWith("## "));
          const contentWithoutHeader =
            firstDateIdx >= 0 ? lines.slice(firstDateIdx).join("\n") : srcContent;
          await fs.promises.appendFile(destFile, "\n" + contentWithoutHeader, "utf-8");
          await fs.promises.unlink(srcFile);
        } else {
          await fs.promises.rename(srcFile, destFile);
        }
      }

      // Merge media subdirectory
      const srcMedia = path.join(fullPath, "media");
      const srcMediaExists = await fs.promises.stat(srcMedia).catch(() => null);
      if (srcMediaExists?.isDirectory()) {
        const destMedia = path.join(targetPath, "media");
        await fs.promises.mkdir(destMedia, { recursive: true });
        const mediaFiles = await fs.promises.readdir(srcMedia);
        for (const mf of mediaFiles) {
          const srcMf = path.join(srcMedia, mf);
          const destMf = path.join(destMedia, mf);
          const destMfExists = await fs.promises.stat(destMf).catch(() => null);
          if (!destMfExists) {
            await fs.promises.rename(srcMf, destMf);
          }
        }
        await fs.promises.rmdir(srcMedia).catch(() => {});
      }

      await fs.promises.rmdir(fullPath).catch(() => {});
      log.info(`Merged: ${entry} -> ${targetSlug}`);
    } else {
      await fs.promises.rename(fullPath, targetPath);
      log.info(`Renamed: ${entry} -> ${targetSlug}`);
    }

    results.push({ from: entry, to: targetSlug, merged });
  }

  return results;
}
