// Top-level migrate command tests cover provider planning, interactive selection, apply flow, and JSON output.
import fs from "node:fs/promises";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import { createNonExitingRuntime, ExitError, type RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackLogMessage: vi.fn(),
  multiselect: vi.fn(),
  progress: {
    setLabel: vi.fn(),
    setPercent: vi.fn(),
    tick: vi.fn(),
  },
  promptYesNo: vi.fn(),
  provider: {
    id: "hermes",
    label: "Hermes",
    plan: vi.fn(),
    apply: vi.fn(),
  },
  withProgress: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
}));

// Per-run unique + realpath'd state dir: the apply flow writes real report dirs under it and
// the suite rm -rf's it, so concurrent runs on one machine must never share the root (macOS
// os.tmpdir() is a /var -> /private/var symlink).
const testStateDir = await vi.hoisted(async () => {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return await realpath(await mkdtemp(join(tmpdir(), "openclaw-migrate-command-test-")));
});

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  resolveStateDir: () => testStateDir,
}));

vi.mock("../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: mocks.withProgress,
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  log: { message: mocks.clackLogMessage },
}));

vi.mock("./migrate/skill-selection-prompt.js", () => ({
  promptMigrationSkillSelectionValues: mocks.multiselect,
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    params: { providerId?: string },
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run([{ ...mocks.provider, id: params.providerId ?? mocks.provider.id }]),
}));

vi.mock("./backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

const { MIGRATION_SELECTION_TOGGLE_ALL_OFF } = await import("./migrate/selection.js");
const { migrateApplyCommand, migrateDefaultCommand, migratePlanCommand } =
  await import("./migrate.js");

function plan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  const items: MigrationPlan["items"] = overrides.items ?? [
    { id: "workspace:AGENTS.md", kind: "workspace", action: "copy", status: "planned" },
  ];
  return {
    providerId: "hermes",
    source: "/tmp/hermes",
    summary: summarizeMigrationItems(items),
    items,
    ...overrides,
  };
}

function migrated(planned: MigrationPlan): MigrationApplyResult {
  return {
    ...planned,
    summary: { ...planned.summary, planned: 0, migrated: planned.summary.planned },
    items: planned.items.map((item) =>
      item.status === "planned" ? { ...item, status: "migrated" as const } : item,
    ),
  };
}

function mockMigration(planned: MigrationPlan = plan()) {
  mocks.provider.plan.mockResolvedValue(planned);
  mocks.provider.apply.mockResolvedValue(migrated(planned));
  return planned;
}

function expectNoApply() {
  for (const mock of [mocks.promptYesNo, mocks.backupCreateCommand, mocks.provider.apply]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function withConflict(planned: MigrationPlan, id: string, reason: string): MigrationPlan {
  return {
    ...planned,
    summary: { ...planned.summary, planned: planned.summary.planned - 1, conflicts: 1 },
    items: planned.items.map((item) =>
      item.id === id ? { ...item, status: "conflict", reason } : item,
    ),
  };
}

function setInteractive() {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
}

function authPlan(status: MigrationPlan["items"][number]["status"] = "skipped"): MigrationPlan {
  return plan({
    items: [
      {
        id: "auth:openai",
        kind: "auth",
        action: status === "planned" ? "create" : "skip",
        status,
        sensitive: true,
        reason: status === "skipped" ? "auth credential migration not selected" : undefined,
      },
    ],
  });
}

function codexPlan(kind: "skill" | "plugin"): MigrationPlan {
  const names = kind === "skill" ? ["alpha", "beta"] : ["google-calendar", "gmail"];
  const items: MigrationPlan["items"] = names.map((name) => ({
    id: `${kind}:${name}`,
    kind,
    action: kind === "skill" ? "copy" : "install",
    status: "planned",
    details: { [`${kind}Name`]: name, configKey: name },
  }));
  if (kind === "skill") {
    items.push({
      id: "archive:config.toml",
      kind: "archive",
      action: "archive",
      status: "planned",
    });
  }
  return plan({
    providerId: "codex",
    items,
  });
}

function codexSkillAndPluginPlan(): MigrationPlan {
  const skills = codexPlan("skill");
  const items = [...skills.items, ...codexPlan("plugin").items];
  return {
    ...skills,
    items,
    summary: summarizeMigrationItems(items),
  };
}

function secretPlan() {
  return plan({
    items: [
      {
        id: "config:mcp-servers",
        kind: "config",
        action: "merge",
        status: "planned",
        details: {
          value: {
            time: {
              env: { OPENAI_API_KEY: "short-dev-key", SAFE_FLAG: "visible" },
              headers: {
                Authorization: "Bearer short-dev-key",
                "x-api-key": "another-short-dev-key",
              },
            },
          },
        },
      },
    ],
  });
}

type MigrationJsonOutput = {
  backupPath?: unknown;
  providerId?: unknown;
  summary?: { planned?: unknown };
  items?: Array<{
    details?: {
      value?: {
        time?: { env?: Record<string, unknown>; headers?: Record<string, unknown> };
      };
    };
  }>;
};

function firstApplyContext(): Record<string, unknown> {
  return mocks.provider.apply.mock.calls[0]?.[0] as Record<string, unknown>;
}

function firstAppliedPlan(): MigrationPlan {
  return mocks.provider.apply.mock.calls[0]?.[1] as MigrationPlan;
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit(code) {
    throw new Error(`exit ${code}`);
  },
};

function captureRuntime(base: RuntimeEnv = runtime) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    jsonRuntime: {
      ...base,
      log(message: unknown) {
        logs.push(String(message));
      },
      error(message: unknown) {
        errors.push(String(message));
      },
    },
  };
}

describe("migrateApplyCommand", () => {
  const originalIsTty = process.stdin.isTTY;

  beforeEach(async () => {
    await fs.rm(testStateDir, { force: true, recursive: true });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    vi.clearAllMocks();
    for (const mock of Object.values({ ...mocks, ...mocks.provider, ...mocks.progress })) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
    mocks.withProgress.mockImplementation(
      async (_opts: unknown, run: (progress: unknown) => unknown) => await run(mocks.progress),
    );
    mocks.backupCreateCommand.mockResolvedValue({ archivePath: "/tmp/openclaw-backup.tgz" });
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
    await fs.rm(testStateDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("requires explicit force before skipping the pre-migration backup", async () => {
    await expect(
      migrateApplyCommand(runtime, { provider: "hermes", yes: true, noBackup: true }),
    ).rejects.toThrow("--no-backup requires --force");
    expect(mocks.provider.plan).not.toHaveBeenCalled();
  });

  it("requires --yes in non-interactive apply mode", async () => {
    await expect(migrateApplyCommand(runtime, { provider: "hermes" })).rejects.toThrow(
      "requires --yes in non-interactive mode. Preview first with openclaw migrate plan 'hermes'.",
    );
    expect(mocks.provider.plan).not.toHaveBeenCalled();
  });

  it("rejects --verify-plugin-apps for non-Codex default and plan paths", async () => {
    await expect(
      migrateDefaultCommand(runtime, { provider: "hermes", verifyPluginApps: true }),
    ).rejects.toThrow("--verify-plugin-apps is only supported for Codex migrations");
    await expect(
      migratePlanCommand(runtime, { provider: "hermes", verifyPluginApps: true }),
    ).rejects.toThrow("--verify-plugin-apps is only supported for Codex migrations");
    expect(mocks.provider.plan).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires confirmation before interactive apply (consent: %s)",
    async (consent) => {
      setInteractive();
      const planned = plan();
      mockMigration(planned);
      mocks.promptYesNo.mockResolvedValue(consent);

      await migrateApplyCommand(runtime, { provider: "hermes" });

      expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
      expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
      if (consent) {
        expect(mocks.backupCreateCommand).toHaveBeenCalledWith(expect.any(Object), {
          output: undefined,
          verify: true,
        });
        expect(firstApplyContext().backupPath).toBe("/tmp/openclaw-backup.tgz");
        expect(firstAppliedPlan()).toBe(planned);
      } else {
        expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
        expect(mocks.provider.apply).not.toHaveBeenCalled();
      }
    },
  );

  it.each([true, false, CANCEL_SYMBOL])(
    "requires interactive auth consent before replanning (%s)",
    async (consent) => {
      setInteractive();
      const skipped = authPlan("skipped");
      const included = authPlan("planned");
      mocks.provider.plan.mockResolvedValueOnce(skipped).mockResolvedValueOnce(included);
      mocks.clackConfirm.mockResolvedValue(consent);
      const result = migrateDefaultCommand(runtime, { provider: "hermes", dryRun: true });
      if (consent === CANCEL_SYMBOL) {
        await expect(result).rejects.toThrow("exit 0");
        expect(mocks.clackCancel).toHaveBeenCalledWith("Migration cancelled.");
        expect(mocks.provider.apply).not.toHaveBeenCalled();
        expect(mocks.promptYesNo).not.toHaveBeenCalled();
      } else {
        expect(await result).toBe(consent ? included : skipped);
      }
      expect(mocks.clackConfirm).toHaveBeenCalledWith({
        message: "Do you want to migrate your auth credentials as well?",
        initialValue: true,
      });
      expect(mocks.provider.plan.mock.calls.map(([ctx]) => ctx.includeSecrets)).toEqual(
        consent === true ? [false, true] : [false],
      );
    },
  );

  it.each([
    { name: "default", options: {} },
    {
      name: "explicit no-auth override",
      options: { includeSecrets: true, authCredentials: false },
    },
  ])("keeps auth credentials skipped with $name", async ({ options }) => {
    mockMigration(authPlan("skipped"));

    await migrateApplyCommand(runtime, {
      provider: "hermes",
      yes: true,
      ...options,
    });

    expect(
      [mocks.provider.plan, mocks.provider.apply].map((mock) =>
        mock.mock.calls.map(([ctx]) => ctx.includeSecrets),
      ),
    ).toEqual([[false], [false]]);
  });

  it.each([
    { label: "skills", command: migrateDefaultCommand, acceptSkills: false },
    { label: "plugins after skills (apply)", command: migrateApplyCommand, acceptSkills: true },
  ])(
    "stops before confirmation and apply when cancelling $label",
    async ({ command, acceptSkills }) => {
      setInteractive();
      const planned = codexSkillAndPluginPlan();
      const original = structuredClone(planned);
      mocks.provider.plan.mockResolvedValue(planned);
      if (acceptSkills) {
        mocks.multiselect.mockResolvedValueOnce(["skill:alpha"]);
      }
      mocks.multiselect.mockResolvedValueOnce(CANCEL_SYMBOL);

      const result = await command(runtime, { provider: "codex" });

      expect(result).toBe(planned);
      expect(planned).toStrictEqual(original);
      expect(mocks.clackCancel).toHaveBeenCalledWith("Migration cancelled.");
      expect(runtime.log).toHaveBeenCalledWith("Migration cancelled.");
      expect(mocks.clackConfirm).not.toHaveBeenCalled();
      expectNoApply();
    },
  );

  it("does not prompt for Codex plugins when --plugin selected them explicitly", async () => {
    setInteractive();
    const planned = codexPlan("plugin");
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) =>
      migrated(selectedPlan),
    );

    await migrateDefaultCommand(runtime, { provider: "codex", plugins: ["gmail"] });

    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    expect(firstAppliedPlan().items.map(({ id, status }) => [id, status])).toEqual([
      ["plugin:google-calendar", "skipped"],
      ["plugin:gmail", "planned"],
    ]);
  });

  it("does not apply archive-only Codex migration work after Toggle all off", async () => {
    setInteractive();
    const planned = codexPlan("skill");
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue([MIGRATION_SELECTION_TOGGLE_ALL_OFF]);

    const result = await migrateDefaultCommand(runtime, { provider: "codex" });

    expectNoApply();
    expect(runtime.log).toHaveBeenCalledWith(
      "No Codex skills or native Codex plugins selected for migration.",
    );
    expect(result.items.map(({ id, status }) => [id, status])).toEqual([
      ["skill:alpha", "skipped"],
      ["skill:beta", "skipped"],
      ["archive:config.toml", "planned"],
    ]);
  });

  it.each([
    { name: "interactive apply without --yes", command: migrateApplyCommand, options: {} },
    {
      name: "root dry-run despite --yes",
      command: migrateDefaultCommand,
      options: { yes: true, dryRun: true },
    },
  ])("prints a JSON plan without applying: $name", async ({ command, options }) => {
    setInteractive();
    const planned = secretPlan();
    const { logs, jsonRuntime } = captureRuntime();
    mocks.provider.plan.mockResolvedValue(planned);

    const result = await command(jsonRuntime, { provider: "hermes", json: true, ...options });

    expect(result).toBe(planned);
    expect(logs).toHaveLength(1);
    const logPayload = JSON.parse(logs[0] ?? "{}") as MigrationJsonOutput;
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.summary?.planned).toBe(1);
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.OPENAI_API_KEY).toBe("[redacted]");
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.SAFE_FLAG).toBe("visible");
    expect(logPayload.items?.[0]?.details?.value?.time?.headers?.Authorization).toBe("[redacted]");
    expect(logs[0]).not.toContain("short-dev-key");
    expectNoApply();
  });

  it("does not create a backup or apply when the preflight plan has conflicts", async () => {
    mocks.provider.plan.mockResolvedValue(
      withConflict(plan(), "workspace:AGENTS.md", "target exists"),
    );

    await expect(migrateApplyCommand(runtime, { provider: "hermes", yes: true })).rejects.toThrow(
      "Migration has 1 conflict",
    );
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it.each(["conflict"] as const)(
    "keeps --skill configuration inside the selected copy when unselected policy is %s",
    async (unselectedStatus) => {
      const planned = plan({
        items: [
          {
            id: "skill:folder",
            kind: "skill",
            action: "copy",
            status: "planned",
            source: "/tmp/hermes/skills/folder",
            details: { skillName: "selected" },
          },
          ...["selected", "unselected", "target-only"].map((key) => ({
            id: `config:skill:${key}`,
            kind: "config" as const,
            action: "merge" as const,
            status: key === "selected" ? ("planned" as const) : unselectedStatus,
            details: { path: ["skills", "entries", key], value: { enabled: false } },
          })),
          { id: "other-config", kind: "config", action: "merge", status: "planned" },
        ],
      });
      mocks.provider.plan.mockResolvedValue(planned);
      mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) =>
        migrated(selectedPlan),
      );

      await migrateApplyCommand(runtime, { provider: "hermes", yes: true, skills: ["folder"] });

      expect(
        firstAppliedPlan()
          .items.filter((item) => item.status === "planned")
          .map((item) => item.id),
      ).toEqual(["skill:folder", "config:skill:selected", "other-config"]);
      expect(firstAppliedPlan().summary.conflicts).toBe(0);
    },
  );

  it("prints only the final result for root apply in JSON mode", async () => {
    const planned = secretPlan();
    const applied = migrated(planned);
    const { logs, errors, jsonRuntime } = captureRuntime();
    mocks.provider.plan.mockImplementation(async (ctx) => {
      ctx.logger.info("provider planning");
      return planned;
    });
    mocks.provider.apply.mockImplementation(async (ctx, selected) => {
      expect(selected).toBe(planned);
      ctx.logger.info("provider applying");
      return applied;
    });

    await migrateDefaultCommand(jsonRuntime, { provider: "hermes", yes: true, json: true });

    expect(logs).toHaveLength(1);
    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(["provider planning", "provider applying"]);
    expect(mocks.withProgress).not.toHaveBeenCalled();
    const logPayload = JSON.parse(logs[0] ?? "{}") as MigrationJsonOutput;
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.backupPath).toBe("/tmp/openclaw-backup.tgz");
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.OPENAI_API_KEY).toBe("[redacted]");
    expect(logPayload.items?.[0]?.details?.value?.time?.headers?.["x-api-key"]).toBe("[redacted]");
    expect(logs[0]).not.toContain("short-dev-key");
    expect(logs[0]).not.toContain("another-short-dev-key");
    expect(logs[0]).not.toContain("Migration plan");
  });

  it.each([
    { field: "errors", itemStatus: "error", reason: "copy failed" },
    { field: "conflicts", itemStatus: "conflict", reason: "target exists" },
  ] as const)(
    "fails after writing JSON output when apply reports $field",
    async ({ field, itemStatus, reason }) => {
      const planned = plan();
      const applied: MigrationApplyResult = {
        ...planned,
        summary: { ...planned.summary, planned: 0, [field]: 1 },
        items: planned.items.map((item) => ({ ...item, status: itemStatus, reason })),
      };
      const { logs, jsonRuntime } = captureRuntime({
        ...runtime,
        exit: createNonExitingRuntime().exit,
      });
      mocks.provider.plan.mockResolvedValue(planned);
      mocks.provider.apply.mockResolvedValue(applied);

      await expect(
        migrateApplyCommand(jsonRuntime, { provider: "hermes", yes: true, json: true }),
      ).rejects.toBeInstanceOf(ExitError);

      expect(logs).toHaveLength(1);
      const logPayload = JSON.parse(logs[0] ?? "{}") as {
        providerId?: unknown;
        reportDir?: unknown;
        summary?: { errors?: unknown; conflicts?: unknown };
      };
      expect(logPayload.providerId).toBe("hermes");
      expect(logPayload.summary?.[field]).toBe(1);
      expect(String(logPayload.reportDir)).toContain("/migration/hermes/");
    },
  );
});
