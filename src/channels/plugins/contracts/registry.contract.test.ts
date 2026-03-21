import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionContractRegistry,
  channelPluginSurfaceKeys,
  directoryContractRegistry,
  pluginContractRegistry,
  sessionBindingContractRegistry,
  setupContractRegistry,
  statusContractRegistry,
  surfaceContractRegistry,
  threadingContractRegistry,
} from "./registry.js";

function listFilesRecursively(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function discoverSessionBindingChannels() {
  const extensionsDir = path.resolve(import.meta.dirname, "../../../../extensions");
  const channels = new Set<string>();
  for (const filePath of listFilesRecursively(extensionsDir)) {
    if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(
      /registerSessionBindingAdapter\(\{[\s\S]*?channel:\s*"([^"]+)"/g,
    )) {
      channels.add(match[1]);
    }
  }
  return [...channels].toSorted();
}

describe("channel contract registry", () => {
  it("does not duplicate channel plugin ids", () => {
    const ids = pluginContractRegistry.map((entry) => entry.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("keeps the surface registry aligned with the plugin registry", () => {
    expect(surfaceContractRegistry.map((entry) => entry.id).toSorted()).toEqual(
      pluginContractRegistry.map((entry) => entry.id).toSorted(),
    );
  });

  it("declares the actual owned channel plugin surfaces explicitly", () => {
    for (const entry of surfaceContractRegistry) {
      const actual = channelPluginSurfaceKeys.filter((surface) => Boolean(entry.plugin[surface]));
      expect([...entry.surfaces].toSorted()).toEqual(actual.toSorted());
    }
  });

  it("only installs deep action coverage for plugins that declare actions", () => {
    const actionSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("actions"))
        .map((entry) => entry.id),
    );
    for (const entry of actionContractRegistry) {
      expect(actionSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("only installs deep setup coverage for plugins that declare setup", () => {
    const setupSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("setup"))
        .map((entry) => entry.id),
    );
    for (const entry of setupContractRegistry) {
      expect(setupSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("only installs deep status coverage for plugins that declare status", () => {
    const statusSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("status"))
        .map((entry) => entry.id),
    );
    for (const entry of statusContractRegistry) {
      expect(statusSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("only installs deep threading coverage for plugins that declare threading", () => {
    const threadingSurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("threading"))
        .map((entry) => entry.id),
    );
    for (const entry of threadingContractRegistry) {
      expect(threadingSurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("covers every declared directory surface with an explicit contract level", () => {
    const directorySurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("directory"))
        .map((entry) => entry.id),
    );
    for (const entry of directoryContractRegistry) {
      expect(directorySurfaceIds.has(entry.id)).toBe(true);
    }
    expect(directoryContractRegistry.map((entry) => entry.id).toSorted()).toEqual(
      [...directorySurfaceIds].toSorted(),
    );
  });

  it("only installs lookup directory coverage for plugins that declare directory", () => {
    const directorySurfaceIds = new Set(
      surfaceContractRegistry
        .filter((entry) => entry.surfaces.includes("directory"))
        .map((entry) => entry.id),
    );
    for (const entry of directoryContractRegistry.filter(
      (candidate) => candidate.coverage === "lookups",
    )) {
      expect(directorySurfaceIds.has(entry.id)).toBe(true);
    }
  });

  it("keeps session binding coverage aligned with registered session binding adapters", () => {
    expect(sessionBindingContractRegistry.map((entry) => entry.id).toSorted()).toEqual(
      discoverSessionBindingChannels(),
    );
  });
});
