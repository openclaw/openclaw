// Setup migration import tests cover importing existing config into onboarding.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { MigrationPlan } from "../plugins/migration-provider.types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { listSetupMigrationOptions, runSetupMigrationImport } from "./setup.migration-import.js";
import {
  assertFreshSetupMigrationTarget,
  buildSetupMigrationPlanSourceSnapshot,
  buildSetupMigrationTargetSnapshot,
  inspectSetupMigrationFreshness,
  preserveSetupMigrationOnboardingConsents,
} from "./setup.migration-snapshot.js";

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("setup migration import freshness", () => {
  const tempRoots = useAutoCleanupTempDirTracker(afterEach);

  it("allows empty config and empty target directories", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows first-launch security and telemetry consent before import", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
        telemetry: { enabled: true, consentedAt: "2026-06-30T00:00:00.000Z" },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("allows runtime-only state scaffolding before import", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(stateDir, "state", "openclaw.sqlite"), "runtime database\n");
    await writeFile(path.join(stateDir, "tmp", "startup"), "runtime scratch\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: {},
      stateDir,
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result).toEqual({ fresh: true, reasons: [] });
  });

  it("ignores runtime state churn while still detecting workspace changes", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const initial = await buildSetupMigrationTargetSnapshot({
      config: {},
      stateDir,
      workspaceDir,
    });

    await writeFile(path.join(stateDir, "state", "openclaw.sqlite"), "runtime database\n");
    expect(await buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir })).toBe(
      initial,
    );

    await writeFile(path.join(workspaceDir, "external.txt"), "concurrent write\n");
    expect(
      await buildSetupMigrationTargetSnapshot({ config: {}, stateDir, workspaceDir }),
    ).not.toBe(initial);
  });

  it("preserves first-launch consent choices across the lock-time config reread", () => {
    expect(
      preserveSetupMigrationOnboardingConsents(
        {},
        {
          wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
          telemetry: { enabled: false, consentedAt: "2026-06-30T00:00:00.000Z" },
        },
      ),
    ).toEqual({
      wizard: { securityAcknowledgedAt: "2026-06-30T00:00:00.000Z" },
      telemetry: { enabled: false, consentedAt: "2026-06-30T00:00:00.000Z" },
    });
  });

  it("binds source symlink contents while keeping target snapshots scoped to the link", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const source = path.join(root, "source");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(source, "memory.md"), "before\n");
    await fs.mkdir(workspaceDir);
    const link = path.join(workspaceDir, "import");
    await fs.symlink(source, link, process.platform === "win32" ? "junction" : "dir");
    const plan: MigrationPlan = {
      providerId: "fixture",
      source: link,
      items: [{ id: "memory", kind: "memory", action: "copy", status: "planned", source: link }],
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    };
    const target = { config: {}, stateDir: path.join(root, "state"), workspaceDir };
    const originalSource = await buildSetupMigrationPlanSourceSnapshot(plan);
    const originalTarget = await buildSetupMigrationTargetSnapshot(target);

    await writeFile(path.join(source, "memory.md"), "after\n");

    expect(await buildSetupMigrationPlanSourceSnapshot(plan)).not.toBe(originalSource);
    expect(await buildSetupMigrationTargetSnapshot(target)).toBe(originalTarget);
  });

  it("rejects other wizard config during import freshness checks", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const result = await inspectSetupMigrationFreshness({
      baseConfig: {
        wizard: {
          securityAcknowledgedAt: "2026-06-30T00:00:00.000Z",
          lastRunMode: "local",
        },
      },
      stateDir: path.join(root, "state"),
      workspaceDir: path.join(root, "workspace"),
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual(["existing config values are loaded"]);
  });

  it("rejects existing config, workspace files, credentials, sessions, and agents", async () => {
    const root = tempRoots.make("openclaw-setup-migration-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");
    await writeFile(path.join(stateDir, "credentials", "provider.json"), "{}\n");
    await writeFile(path.join(stateDir, "sessions", "session.json"), "{}\n");
    await writeFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}\n");

    const result = await inspectSetupMigrationFreshness({
      baseConfig: { gateway: { port: 3131 } },
      stateDir,
      workspaceDir,
    });

    expect(result.fresh).toBe(false);
    expect(result.reasons).toEqual([
      "existing config values are loaded",
      "workspace MEMORY.md exists",
      "state credentials/ exists",
      "state sessions/ exists",
      "state agents/ exists",
    ]);
    expect(() => assertFreshSetupMigrationTarget(result)).toThrow(
      "Migration import during onboarding requires a fresh OpenClaw setup.",
    );
  });
});

describe("setup migration import options", () => {
  let initialOptions: Awaited<ReturnType<typeof listSetupMigrationOptions>>;

  beforeAll(async () => {
    initialOptions = await listSetupMigrationOptions({
      baseConfig: {},
      detections: [],
    });
  });

  it("lists bundled providers for the nested migration source picker", () => {
    expect(initialOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "codex", label: "Import from Codex" }),
        expect.objectContaining({ providerId: "claude", label: "Import from Claude" }),
        expect.objectContaining({ providerId: "hermes", label: "Import from Hermes" }),
      ]),
    );
  });

  it("does not offer install-only providers during a transactional import", async () => {
    const previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    try {
      const options = await listSetupMigrationOptions({
        baseConfig: {},
        detections: [],
      });

      expect(options).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ providerId: "codex" })]),
      );
    } finally {
      if (previousDisableBundled === undefined) {
        delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      } else {
        process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
      }
    }
  });
});

describe("setup migration import provider selection", () => {
  function runImportWith(importFrom: string) {
    return runSetupMigrationImport({
      opts: { importFrom } as OnboardOptions,
      baseConfig: {},
      detections: [],
      prompter: {} as WizardPrompter,
      runtime: { log: () => {}, error: () => {}, exit: () => {} } as unknown as RuntimeEnv,
      readConfigFile: async () => ({}),
      commitConfigFile: async (config) => config,
    });
  }

  it("names the available providers when --import-from does not match one", async () => {
    // The bundled ids come from the same listing the picker renders, so assert the shape and one
    // known bundled id rather than pinning the full set, which grows with every bundled provider.
    await expect(runImportWith("bogus")).rejects.toThrow(
      /^Unknown migration provider "bogus"\. Available providers: .*codex.*\. Run .*openclaw migrate list.* to see the current list\.$/,
    );
  });
});
