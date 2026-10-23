import fs from "node:fs/promises";
import path from "node:path";
import type { HookStatusEntry } from "../hooks/hooks-status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";

export function makeHookStatusEntry(overrides: Partial<HookStatusEntry> = {}): HookStatusEntry {
  const baseDir = overrides.baseDir ?? "/tmp/hooks/session-memory";
  return {
    name: "session-memory",
    description: "Save session context to memory",
    source: "openclaw-bundled",
    baseDir,
    filePath: `${baseDir}/HOOK.md`,
    handlerPath: `${baseDir}/handler.js`,
    hookKey: "session-memory",
    events: ["command:new"],
    unknownEvents: [],
    always: false,
    enabledByConfig: true,
    requirementsSatisfied: true,
    loadable: true,
    managedByPlugin: false,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
}

export async function writeFixtureJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value));
}

export async function writeCliPluginFixture(
  directory: string,
  name: string,
  manifest: Record<string, unknown>,
  source: string,
) {
  await fs.mkdir(directory, { recursive: true });
  await writeFixtureJson(path.join(directory, "package.json"), {
    name,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  await writeFixtureJson(path.join(directory, "openclaw.plugin.json"), {
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    ...manifest,
  });
  await fs.writeFile(path.join(directory, "index.js"), source);
}
