import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginsSkillsReadResult } from "../../packages/gateway-protocol/src/schema/plugin-skills.js";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
} from "../../packages/gateway-protocol/src/schema/skill-library.js";
import { SKILL_LIBRARY_MAX_TREE_ENTRIES } from "../skills/library/bundle.js";
import {
  pluginSkillFileFromBytes,
  validatePluginSkillPath,
} from "../skills/loading/plugin-skill-bundle.js";
import {
  fetchClawHubJson,
  withClawHubResponse,
  readClawHubBytes,
  readRequiredClawHubStringField,
  readRequiredClawHubNumberField,
  type ClawHubRequestParams,
} from "./clawhub-client.js";

/** A release inventory supplies both the declared boundary and exact hashes; no archive or install. */
export async function fetchClawHubPluginSkill(
  params: Pick<
    ClawHubRequestParams,
    "baseUrl" | "token" | "skipAuth" | "timeoutMs" | "fetchImpl"
  > & { packageName: string; version: string; skillName: string; path?: string },
): Promise<PluginsSkillsReadResult> {
  // Inventory plus one selected body share the request budget; never prefetch siblings.
  if (params.path !== undefined) {
    validatePluginSkillPath(params.path);
  }
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const basePath = `/api/v1/packages/${encodeURIComponent(params.packageName)}`;
  const value = await fetchClawHubJson<unknown>({
    ...params,
    timeoutMs: remainingMs(),
    retryTransientReads: false,
    path: `${basePath}/versions/${encodeURIComponent(params.version)}`,
  });
  if (
    !isRecord(value) ||
    !isRecord(value.package) ||
    value.package.name !== params.packageName ||
    !isRecord(value.version) ||
    value.version.version !== params.version ||
    !Array.isArray(value.version.files) ||
    !isRecord(value.version.pluginManifestSummary) ||
    !Array.isArray(value.version.pluginManifestSummary.bundledSkills)
  ) {
    throw new Error("ClawHub did not return the selected plugin version and skill inventory.");
  }
  const matches = value.version.pluginManifestSummary.bundledSkills.filter(
    (skill) => isRecord(skill) && skill.name === params.skillName,
  );
  const selected = matches[0];
  if (matches.length !== 1 || !isRecord(selected)) {
    throw new Error(matches.length ? "Plugin skill name is ambiguous." : "Plugin skill not found.");
  }
  const rootPath = readRequiredClawHubStringField(selected, "rootPath", "bundled skill");
  const rawEntry = readRequiredClawHubStringField(selected, "skillMdPath", "bundled skill");
  const entry = rawEntry.replace(/^(?:\.\/)+/u, "");
  if (rootPath !== ".") {
    validatePluginSkillPath(rootPath);
  }
  // A declared package-root skill owns the whole exact-version inventory.
  const prefix = rootPath === "." ? "" : `${rootPath}/`;
  const entryPath = entry.slice(prefix.length);
  if (!entry.startsWith(prefix) || entryPath.toLowerCase() !== "skill.md") {
    throw new Error("ClawHub skill entry is outside its declared bundle.");
  }
  const files = value.version.files
    .flatMap((candidate) => {
      if (!isRecord(candidate)) {
        throw new Error("Invalid ClawHub file inventory.");
      }
      const fullPath = readRequiredClawHubStringField(candidate, "path", "skill file");
      // Display paths normalize the leading dot; fetches retain signed inventory bytes.
      const bundlePath = fullPath.replace(/^(?:\.\/)+/u, "");
      if (!bundlePath.startsWith(prefix)) {
        return [];
      }
      // Root and skill-relative paths have independent portable-path bounds,
      // matching the installed reader without changing signed fetch paths.
      const filePath = bundlePath.slice(prefix.length);
      validatePluginSkillPath(filePath);
      const size = readRequiredClawHubNumberField(candidate, "size", "skill file");
      const hash = readRequiredClawHubStringField(candidate, "sha256", "skill file");
      if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/u.test(hash)) {
        throw new Error("Invalid ClawHub skill file integrity metadata.");
      }
      return [{ path: filePath, fullPath, size, hash }];
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length > SKILL_LIBRARY_MAX_FILES) {
    throw new Error("Skill bundle exceeds file count limit.");
  }
  if (
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
    !files.some((file) => file.fullPath === rawEntry && file.path === entryPath)
  ) {
    throw new Error("ClawHub skill inventory is incomplete or ambiguous.");
  }
  const selectedPath = params.path ?? entryPath;
  if (!files.some((file) => file.path === selectedPath)) {
    throw new Error("Plugin skill file not found.");
  }
  const directories = new Set(
    files.flatMap((file) => {
      const parts = file.path.split("/");
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  if (files.length + directories.size > SKILL_LIBRARY_MAX_TREE_ENTRIES) {
    throw new Error("Skill bundle exceeds inventory limits.");
  }
  const result: PluginsSkillsReadResult = {
    name: params.skillName,
    rootPath,
    entryPath,
    version: params.version,
    files: [],
    directories: [],
    inventoryComplete: true,
  };
  let totalBytes = 0;
  for (const file of files) {
    if (
      file.size > SKILL_LIBRARY_MAX_FILE_BYTES ||
      totalBytes + file.size > SKILL_LIBRARY_MAX_BUNDLE_BYTES
    ) {
      result.files.push({ path: file.path, sizeBytes: file.size, status: "too-large" });
      continue;
    }
    // Charge the complete eligible inventory in deterministic order so selections
    // cannot evade the aggregate bundle limit. Only the chosen body is transferred.
    totalBytes += file.size;
    if (file.path !== selectedPath) {
      result.files.push({ path: file.path, sizeBytes: file.size, status: "deferred" });
      continue;
    }
    if (Date.now() >= deadline) {
      result.files.push({ path: file.path, sizeBytes: file.size, status: "unavailable" });
      continue;
    }
    try {
      const read = await withClawHubResponse(
        {
          ...params,
          timeoutMs: remainingMs(),
          retryTransientReads: false,
          path: `${basePath}/file`,
          search: { path: file.fullPath, version: params.version },
          headers: { Accept: "application/octet-stream" },
        },
        async ({ response }) => {
          if (!response.ok) {
            return {
              path: file.path,
              sizeBytes: file.size,
              status: response.status === 413 ? ("too-large" as const) : ("unavailable" as const),
            };
          }
          const buffer = await readClawHubBytes({
            response,
            maxBytes: Math.max(1, file.size),
            timeoutMs: remainingMs(),
            resourceLabel: "plugin skill file",
          });
          if (
            buffer.length !== file.size ||
            createHash("sha256").update(buffer).digest("hex") !== file.hash
          ) {
            return { path: file.path, sizeBytes: file.size, status: "unavailable" as const };
          }
          return pluginSkillFileFromBytes(file.path, buffer);
        },
      );
      result.files.push(read);
    } catch {
      result.files.push({ path: file.path, sizeBytes: file.size, status: "unavailable" });
    }
  }
  result.directories = [...directories].toSorted();
  return result;
}
