import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import * as updateCheck from "../../infra/update-check.js";

export const validConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  resolved: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

export const successfulPluginUpdate = {
  status: "ok" as const,
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

export function expectLifecycleBoundary(events: readonly string[], preLeaseEvent: string): void {
  const preLeaseIndex = events.indexOf(`${preLeaseEvent}:false`);
  expect(preLeaseIndex).toBeGreaterThan(-1);
  expect(events).not.toContain(`${preLeaseEvent}:true`);
  const authoritativeReadIndex = events.findIndex(
    (event, index) => index > preLeaseIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(preLeaseIndex);
  for (const event of ["prepare-config:true", "installed-records:true", "plugin-update:true"]) {
    expect(events).toContain(event);
  }
  expect(events.indexOf("plugin-update:true")).toBeGreaterThan(authoritativeReadIndex);
}

export const finalizationCleanupCases = [
  { phase: "preflight", cleanup: "forced", failed: false },
  { phase: "preflight", cleanup: "uncertain", failed: false },
  { phase: "completion", cleanup: "forced", failed: false },
  { phase: "completion", cleanup: "uncertain", failed: false },
  { phase: "completion", cleanup: "forced", failed: true },
  { phase: "completion", cleanup: "uncertain", failed: true },
  { phase: "recovery", cleanup: "forced", failed: true },
  { phase: "recovery", cleanup: "uncertain", failed: true },
] as const;

export async function prepareFinalizationPackage(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
}
