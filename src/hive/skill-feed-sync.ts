import fs from "node:fs/promises";
import path from "node:path";
import { installSkillFromClawHub } from "../agents/skills-clawhub.js";
import {
  computeDirectoryContentHash,
  computeSkillMarkdownHash,
  readHubLockfile,
  upsertLockSkill,
  writeHubLockfile,
  type HubLockSkillEntry,
} from "../agents/skills-hub/lockfile.js";
import { enforceManagedScanPolicy } from "../agents/skills-hub/managed.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ClawHubSkillDetail } from "../infra/clawhub.js";
import { fetchClawHubSkillDetail, resolveClawHubBaseUrl } from "../infra/clawhub.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import { CONFIG_DIR } from "../utils.js";
import { SkillFeedV1Schema, type SkillFeedV1 } from "./types.js";

export type HiveSkillFeedSyncDeps = {
  fetchClawHubSkillDetail?: typeof fetchClawHubSkillDetail;
  installSkillFromClawHub?: typeof installSkillFromClawHub;
};

function summarizeVerdict(summary: {
  critical: number;
  warn: number;
}): HubLockSkillEntry["scan"]["verdict"] {
  if (summary.critical > 0) {
    return "critical";
  }
  if (summary.warn > 0) {
    return "warn";
  }
  return "safe";
}

function hiveFieldsFromDetail(
  detail: ClawHubSkillDetail,
  slug: string,
): Pick<HubLockSkillEntry, "hiveSkillId" | "hiveContributorPseudonym"> {
  const owner = detail.owner?.handle?.trim();
  return {
    hiveSkillId: slug,
    ...(owner ? { hiveContributorPseudonym: owner } : {}),
  };
}

export async function parseSkillFeedV1FromFile(filePath: string): Promise<SkillFeedV1> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  return SkillFeedV1Schema.parse(raw);
}

/**
 * Pulls ClawHub-backed skills from a v1 manifest into the managed hub lockfile (`hub.lock.json`).
 * No-op when `skills.hive.enabled` is not true. Uses HTTPS only via `clawhub.ts` (host-constrained base URL).
 */
export async function syncHiveSkillFeed(params: {
  cfg: OpenClawConfig;
  manifest: SkillFeedV1;
  deps?: HiveSkillFeedSyncDeps;
  baseUrl?: string;
}): Promise<{
  ok: boolean;
  skipped?: boolean;
  results: Array<{ slug: string; ok: boolean; message?: string }>;
}> {
  if (params.cfg.skills?.hive?.enabled !== true) {
    return { ok: true, skipped: true, results: [] };
  }

  const fetchDetail = params.deps?.fetchClawHubSkillDetail ?? fetchClawHubSkillDetail;
  const install = params.deps?.installSkillFromClawHub ?? installSkillFromClawHub;

  const managedRoot = path.join(CONFIG_DIR, "skills");
  const lockPath = path.join(managedRoot, "hub.lock.json");
  let lock = await readHubLockfile(lockPath);
  const results: Array<{ slug: string; ok: boolean; message?: string }> = [];

  for (const entry of params.manifest.entries) {
    const slug = entry.slug.trim();
    try {
      const detail = await fetchDetail({ slug, baseUrl: params.baseUrl });
      if (!detail.skill) {
        results.push({ slug, ok: false, message: "not found on ClawHub" });
        continue;
      }
      const resolvedVersion = entry.version?.trim() || detail.latestVersion?.version;
      if (!resolvedVersion) {
        results.push({ slug, ok: false, message: "no installable version" });
        continue;
      }
      const installed = await install({
        workspaceDir: CONFIG_DIR,
        slug,
        version: resolvedVersion,
        force: true,
        baseUrl: params.baseUrl,
      });
      if (!installed.ok) {
        results.push({ slug, ok: false, message: installed.error });
        continue;
      }
      const skillDir = path.join(managedRoot, slug);
      const summary = await scanDirectoryWithSummary(skillDir);
      const policy = enforceManagedScanPolicy({ summary, skillName: slug, force: false });
      if (!policy.ok) {
        results.push({ slug, ok: false, message: policy.message });
        continue;
      }
      const baseUrlResolved = resolveClawHubBaseUrl(params.baseUrl);
      const hive = hiveFieldsFromDetail(detail, slug);
      const skillMdHash = await computeSkillMarkdownHash(skillDir);
      const row: HubLockSkillEntry = {
        name: slug,
        source: "clawhub",
        url: `${baseUrlResolved.replace(/\/+$/, "")}/skills/${encodeURIComponent(slug)}`,
        ref: resolvedVersion,
        contentHash: await computeDirectoryContentHash(skillDir),
        ...(skillMdHash ? { skillMdHash } : {}),
        scan: {
          critical: summary.critical,
          warn: summary.warn,
          info: summary.info,
          verdict: summarizeVerdict(summary),
        },
        installedAt: Date.now(),
        lastVerifiedPolicyVersion: summary.policyVersion,
        hiveSyncedAt: Date.now(),
        ...hive,
      };
      lock = upsertLockSkill(lock, row);
      results.push({ slug, ok: true });
    } catch (err) {
      results.push({
        slug,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await writeHubLockfile(lockPath, lock);
  return { ok: results.every((r) => r.ok), results };
}
