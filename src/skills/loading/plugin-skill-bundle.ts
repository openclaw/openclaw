import { TextDecoder } from "node:util";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type {
  PluginSkillFile,
  PluginsSkillsReadResult,
} from "../../../packages/gateway-protocol/src/schema/plugin-skills.js";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import {
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
  SKILL_LIBRARY_MAX_TREE_ENTRIES,
} from "../library/bundle.js";

/** Portable relative paths keep catalog paths and installed reads on the same boundary. */
export function validatePluginSkillPath(value: string): void {
  const parts = value.split("/");
  if (
    !value ||
    value.length > 512 ||
    parts.length > SKILL_LIBRARY_MAX_PATH_COMPONENTS ||
    parts.some((part) => !part || part === "." || part === "..") ||
    containsAsciiControlCharacter(value) ||
    /[\\:]/u.test(value)
  ) {
    throw new Error("Invalid plugin skill bundle path.");
  }
}

export function pluginSkillFileFromBytes(filePath: string, buffer: Uint8Array): PluginSkillFile {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    // UTF-8 reserves these byte values for C0 controls; TAB/LF/CR remain text whitespace.
    if (buffer.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      throw new Error("Binary content");
    }
    return { path: filePath, sizeBytes: buffer.length, status: "ready", content };
  } catch {
    return { path: filePath, sizeBytes: buffer.length, status: "binary" };
  }
}

/** Inventory and reads share one pinned plugin root; links are represented but never followed. */
export async function readPluginSkillBundle(params: {
  pluginRoot: string;
  rootPath: string;
  name: string;
  rejectHardlinks: boolean;
  path?: string;
}): Promise<PluginsSkillsReadResult> {
  if (params.rootPath !== ".") {
    validatePluginSkillPath(params.rootPath);
  }
  const selectedPath = params.path ?? "SKILL.md";
  validatePluginSkillPath(selectedPath);
  const owner = await root(params.pluginRoot);
  const result: PluginsSkillsReadResult = {
    name: params.name,
    rootPath: params.rootPath,
    entryPath: "SKILL.md",
    files: [],
    directories: [],
    inventoryComplete: true,
  };
  let entries = 0;
  let bytes = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > SKILL_LIBRARY_MAX_PATH_COMPONENTS) {
      throw new Error("Skill bundle exceeds directory depth limit.");
    }
    const relative = directory ? `${params.rootPath}/${directory}` : params.rootPath;
    for await (const entry of owner.entries(relative, {
      order: "sorted",
      maxEntries: SKILL_LIBRARY_MAX_TREE_ENTRIES - entries,
      symlinks: "reject",
    })) {
      if (++entries > SKILL_LIBRARY_MAX_TREE_ENTRIES) {
        throw new Error("Skill bundle exceeds inventory limits.");
      }
      const filePath = directory ? `${directory}/${entry.name}` : entry.name;
      validatePluginSkillPath(filePath);
      if (entry.isDirectory && !entry.isSymbolicLink) {
        result.directories.push(filePath);
        await visit(filePath, depth + 1);
        continue;
      }
      if (result.files.length >= SKILL_LIBRARY_MAX_FILES) {
        throw new Error("Skill bundle exceeds file count limit.");
      }
      const file: PluginSkillFile = {
        path: filePath,
        sizeBytes: entry.size,
        status: "unavailable",
      };
      result.files.push(file);
      if (!entry.isFile || entry.isSymbolicLink) {
        continue;
      }
      if (
        entry.size > SKILL_LIBRARY_MAX_FILE_BYTES ||
        bytes + entry.size > SKILL_LIBRARY_MAX_BUNDLE_BYTES
      ) {
        file.status = "too-large";
        continue;
      }
      bytes += entry.size;
      file.status = "deferred";
    }
  }
  await visit("", 0);
  if (params.path !== undefined && !result.files.some((file) => file.path === selectedPath)) {
    throw new Error("Plugin skill file not found.");
  }
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const selected = result.files.find((file) => file.path === selectedPath);
  if (selected?.status === "deferred") {
    selected.status = "unavailable";
    try {
      // Validate the entire inventory before touching a body. A changing file
      // cannot exceed its reserved inventory size (plus fs-safe's overflow probe).
      const read = await owner.read(`${params.rootPath}/${selectedPath}`, {
        symlinks: "reject",
        hardlinks: params.rejectHardlinks ? "reject" : "allow",
        maxBytes: selected.sizeBytes,
      });
      Object.assign(selected, pluginSkillFileFromBytes(selectedPath, read.buffer));
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "too-large") {
        selected.status = "too-large";
      }
    }
  }
  return result;
}
