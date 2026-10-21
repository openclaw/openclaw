import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import { assertAgentHarnessRunAdmission } from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import {
  createTestConfigFileStore,
  createThrowingTestRuntime,
} from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "../infra/device-identity-material.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationConfigRuntime,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { captureEnv } from "../test-utils/env.js";
import { WizardNavigationError, type WizardPrompter, type WizardSelectParams } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  canonicalMutateConfigFile: vi.fn(),
  provider: undefined as MigrationProviderPlugin | undefined,
  verify: vi.fn(),
  runEmbedded: vi.fn<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>(),
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(mocks.provider ? [mocks.provider] : []),
}));

vi.mock("./setup.inference-verification.js", () => ({
  offerLiveModelVerification: mocks.verify,
}));

vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbedded }));

vi.mock("../config/mutate.js", () => ({
  mutateConfigFile: mocks.canonicalMutateConfigFile,
}));

import { runSetupMigrationImport } from "./setup.migration-import.js";
import "../system-agent/setup-inference.js";

const { offerLiveModelVerification } = await vi.importActual<
  typeof import("./setup.inference-verification.js")
>("./setup.inference-verification.js");

const tempRoots = createTempDirTracker();
let environment: ReturnType<typeof captureEnv>;
let fixture: Awaited<ReturnType<typeof createImportFixture>>;

function prompter(): WizardPrompter {
  return createWizardPrompter({ confirm: vi.fn(async () => true) }, { defaultSelect: "claude" });
}

function memoryPath(root: string) {
  return path.join(root, "workspace", "MEMORY.md");
}

function importedCredential(database: string) {
  return loadPersistedAuthProfileStoreAtDatabasePath(database, "agent")?.profiles[
    "openai:imported"
  ];
}

async function mutateConfig(
  ctx: MigrationProviderContext,
  mutate: (draft: OpenClawConfig) => void,
) {
  assert(ctx.configRuntime, "missing config runtime");
  await ctx.configRuntime.mutateConfigFile({
    base: "runtime",
    afterWrite: { mode: "none", reason: "migration test" },
    mutate,
  });
}

async function expectUnpromoted(root: string, currentConfig: { value: Record<string, unknown> }) {
  await expect(fs.access(memoryPath(root))).rejects.toThrow();
  expect(currentConfig.value).toEqual({});
}

function provider(params: {
  source: string;
  mutateDuringApply?: (ctx: MigrationProviderContext) => Promise<void>;
  deferred?: boolean;
  retrySafeDeferred?: boolean;
  deferredItemIds?: string[];
  onDeferredApply?: (
    itemId: string,
    ctx: MigrationProviderContext,
  ) => Promise<"error" | "migrated">;
}): MigrationProviderPlugin {
  return {
    id: "claude",
    label: "Claude",
    ...(params.deferred && params.retrySafeDeferred !== false
      ? { deferredApply: { retrySafe: true as const } }
      : {}),
    async plan(ctx) {
      const workspace = ctx.config.agents?.defaults?.workspace;
      assert(workspace, "missing workspace");
      const items: MigrationPlan["items"] = [
        {
          id: "workspace:memory",
          kind: "memory",
          action: "copy",
          status: "planned",
          source: params.source,
          target: path.join(workspace, "MEMORY.md"),
        },
      ];
      if (params.deferred) {
        for (const itemId of params.deferredItemIds ?? ["plugin:calendar"]) {
          items.push({
            id: itemId,
            kind: "plugin",
            action: "install",
            status: "planned",
            applyPhase: "after-promotion",
            target: `plugins.entries.codex.config.codexPlugins.plugins.${itemId}`,
          });
        }
      }
      return {
        providerId: "claude",
        source: params.source,
        target: workspace,
        items,
        summary: summarizeMigrationItems(items),
      };
    },
    async apply(ctx, plan): Promise<MigrationApplyResult> {
      assert(plan, "missing plan");
      const items = plan.items.map((item) => ({ ...item }));
      for (const item of items) {
        if (item.status === "planned" && item.id === "workspace:memory") {
          await fs.mkdir(path.dirname(item.target!), { recursive: true });
          await fs.copyFile(item.source!, item.target!);
          item.status = "migrated";
        } else if (item.status === "planned" && item.applyPhase === "after-promotion") {
          const status = (await params.onDeferredApply?.(item.id, ctx)) ?? "error";
          item.status = status;
          if (status === "error") {
            item.reason = "activation failed";
          }
        }
      }
      await params.mutateDuringApply?.(ctx);
      return {
        ...plan,
        items,
        summary: summarizeMigrationItems(items),
        reportDir: ctx.reportDir,
      };
    },
  };
}

async function createImportFixture() {
  const root = await fs.realpath(tempRoots.make("openclaw-migration-transaction-"));
  const source = path.join(root, "source-memory.md");
  await fs.writeFile(source, "remember this\n", "utf8");
  const currentConfig: { value: OpenClawConfig } = { value: {} };
  process.env.OPENCLAW_STATE_DIR = path.join(root, "openclaw-state");
  mocks.provider = provider({ source });
  return {
    root,
    source,
    currentConfig,
    install: (options: Omit<Parameters<typeof provider>[0], "source"> = {}) =>
      (mocks.provider = provider({ source, ...options })),
    run: (interactivePrompter?: WizardPrompter) =>
      runSetupMigrationImport({
        opts: {
          importSource: source,
          workspace: path.join(root, "workspace"),
          ...(interactivePrompter ? {} : { importFrom: "claude", nonInteractive: true }),
        },
        baseConfig: {},
        detections: [],
        prompter: interactivePrompter ?? prompter(),
        runtime: createThrowingTestRuntime(),
        allowProviderBack: interactivePrompter !== undefined,
        readConfigFile: async () => structuredClone(currentConfig.value),
        commitConfigFile: async (config) => (currentConfig.value = structuredClone(config)),
        continueOnboarding: true,
      }),
    unpromoted: () => expectUnpromoted(root, currentConfig),
    memory: () => fs.readFile(memoryPath(root), "utf8"),
  };
}

async function readImportReport(root: string): Promise<{
  report: MigrationApplyResult;
  journal: { status: string };
}> {
  const reportRoot = path.join(root, "openclaw-state", "migration", "claude");
  const [reportDir] = await fs.readdir(reportRoot);
  const read = async (file: string) =>
    JSON.parse(await fs.readFile(path.join(reportRoot, reportDir!, file), "utf8"));
  return { report: await read("report.json"), journal: await read("onboarding-promotion.json") };
}

beforeEach(async () => {
  environment = captureEnv(["OPENCLAW_STATE_DIR"]);
  fixture = await createImportFixture();
  mocks.canonicalMutateConfigFile.mockReset();
  const configFiles = createTestConfigFileStore();
  mocks.canonicalMutateConfigFile.mockImplementation(
    async (mutation: Parameters<MigrationConfigRuntime["mutateConfigFile"]>[0]) => {
      const draft = structuredClone(fixture.currentConfig.value);
      const baseline = configFiles.write(draft);
      const result = await mutation.mutate(draft, baseline);
      fixture.currentConfig.value = structuredClone(draft);
      return {
        ...configFiles.write(draft),
        result,
        afterWrite: mutation.afterWrite,
        followUp: { mode: "none", reason: "fixture", requiresRestart: false },
      };
    },
  );
  mocks.runEmbedded.mockReset();
  mocks.verify.mockReset();
});

afterEach(async () => {
  const [{ closeOpenClawAgentDatabasesForTest }, { closeOpenClawStateDatabaseForTest }] =
    await Promise.all([
      import("../state/openclaw-agent-db.js"),
      import("../state/openclaw-state-db.js"),
    ]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  mocks.provider = undefined;
  environment.restore();
  tempRoots.cleanup();
});

it("returns before migration side effects when the source picker goes back", async () => {
  const select = vi.fn(async (params: WizardSelectParams<unknown>) => {
    expect(params.navigation).toMatchObject({ canGoBack: true });
    throw new WizardNavigationError("back");
  }) as WizardPrompter["select"];
  await expect(fixture.run({ ...prompter(), select })).resolves.toEqual({ kind: "back" });
  await fixture.unpromoted();
});

it("rejects deferred activation from providers without a retry-safe contract", async () => {
  fixture.install({ deferred: true, retrySafeDeferred: false });
  await expect(fixture.run()).rejects.toThrow("does not declare retry-safe deferred apply");
  await fixture.unpromoted();
});

it.each([true, false])(
  "verifies a pre-roster import without durable session admission (provider succeeds: %s)",
  async (providerSucceeds) => {
    const { root, source, currentConfig } = fixture;
    const credential = {
      type: "api_key",
      provider: "openai",
      key: "synthetic-import-key",
    } as const;
    fixture.install({
      mutateDuringApply: async (ctx) => {
        await mutateConfig(ctx, (draft) => {
          draft.agents ??= {};
          draft.agents.defaults ??= {};
          draft.agents.defaults.model = { primary: "openai/gpt-5.6-sol" };
        });
        expect(
          await updateAuthProfileStoreWithLock({
            agentDir: path.join(ctx.stateDir, "agents", "main", "agent"),
            stateDir: ctx.stateDir,
            saveOptions: { syncExternalCli: false },
            updater(store) {
              store.profiles["openai:imported"] = credential;
              return true;
            },
          }),
        ).not.toBeNull();
      },
    });
    const liveDatabase = path.join(root, "openclaw-state/agents/main/agent/openclaw-agent.sqlite");
    let admitted = false;
    mocks.runEmbedded.mockImplementation(async (params) => {
      await fixture.unpromoted();
      await expect(fs.access(liveDatabase)).rejects.toThrow();
      expect(params).toMatchObject({
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: expect.stringMatching(/^agent:main:setup-inference:/),
        agentDir: expect.stringMatching(/\.openclaw-migration-state-[^/]+\/agents\/main\/agent$/),
        authProfileStateMode: "read-only",
        preparedModelRuntimeMode: "isolated-read-only",
      });
      expect(params.agentHarnessRuntimeOverride).toBeUndefined();
      expect(resolveRunWorkspaceDir(params).agentId).toBe("main");
      expect(importedCredential(path.join(params.agentDir!, "openclaw-agent.sqlite"))).toEqual(
        credential,
      );
      // Exercise real admission before staged promotion, not only its in-memory transcript.
      await assertAgentHarnessRunAdmission(params);
      admitted = true;
      if (!providerSucceeds) {
        throw new Error("provider unavailable");
      }
      return {
        payloads: [{ text: "OK" }],
        meta: {
          durationMs: 1,
          executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
        },
      };
    });
    mocks.verify.mockImplementation(
      async (params: Parameters<typeof offerLiveModelVerification>[0]) => {
        const before = structuredClone(params.config);
        expect(before.agents?.entries).toBeUndefined();
        const result = await offerLiveModelVerification(params);
        expect(admitted, JSON.stringify(vi.mocked(params.prompter.note).mock.calls)).toBe(true);
        expect([params.config, result.config]).toEqual([before, before]);
        return result;
      },
    );
    const imported = fixture.run();
    if (providerSucceeds) {
      await expect(imported).resolves.toEqual({
        kind: "verified-inference",
        modelRef: "openai/gpt-5.6-sol",
      });
      expect(await fixture.memory()).toBe("remember this\n");
      expect(currentConfig.value.agents?.entries).toBeUndefined();
      expect(JSON.stringify(currentConfig.value)).not.toContain(".openclaw-migration-");
      expect(importedCredential(liveDatabase)).toEqual(credential);
    } else {
      await expect(imported).rejects.toThrow("Imported inference was not verified.");
      await fixture.unpromoted();
      await expect(fs.access(liveDatabase)).rejects.toThrow();
    }
    expect(mocks.runEmbedded).toHaveBeenCalledOnce();
    expect(await fs.readFile(source, "utf8")).toBe("remember this\n");
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-migration-")),
    ).toEqual([]);
  },
);

it.each(["source", "target"] as const)(
  "aborts promotion when the %s changes during apply",
  async (changed) => {
    const externalFile = path.join(fixture.root, "workspace", "external.txt");
    fixture.install({
      mutateDuringApply: async () => {
        if (changed === "source") {
          await fs.appendFile(fixture.source, "after\n", "utf8");
        } else {
          await fs.mkdir(path.dirname(externalFile), { recursive: true });
          await fs.writeFile(externalFile, "concurrent write\n", "utf8");
        }
      },
    });
    await expect(fixture.run()).rejects.toThrow(`Migration ${changed} changed before promotion`);
    await fixture.unpromoted();
    if (changed === "target") {
      expect(await fs.readFile(externalFile, "utf8")).toBe("concurrent write\n");
    }
  },
);

it("promotes while the live runtime state database changes during staged apply", async () => {
  const { root, currentConfig } = fixture;
  const stateDir = path.join(root, "openclaw-state");
  const liveEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const runtimeDatabasePath = path.join(root, "runtime-agent.sqlite");
  let liveClientBytes: Buffer | undefined;
  fixture.install({
    mutateDuringApply: async (ctx) => {
      using stagedCredentials = openClientCredentialCustody(
        { OPENCLAW_STATE_DIR: ctx.stateDir },
        { migration: true, readOnly: true },
      );
      assert(stagedCredentials, "missing staged credential companion");
      expect(readClientCredentialReceipt(stagedCredentials.database)).toMatchObject({
        phase: "complete",
        receipt: { source: { kind: "canonical", engine: "sqlite" }, legacyImports: {} },
      });
      registerOpenClawAgentDatabase({
        agentId: "runtime",
        path: runtimeDatabasePath,
        env: liveEnv,
      });
      {
        using credentials = openClientCredentialCustody(liveEnv, { migration: true });
        expect(credentials).toBeDefined();
        credentials!.run({
          kind: "identity.create",
          identity: storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(42), 42),
        });
      }
      liveClientBytes = await fs.readFile(resolveClientCredentialStorePath(liveEnv));
    },
  });
  await expect(fixture.run()).resolves.toEqual({
    kind: "no-imported-inference",
  });
  expect(await fixture.memory()).toBe("remember this\n");
  expect(JSON.stringify(currentConfig.value)).not.toContain(".openclaw-migration-");
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(liveClientBytes).toBeDefined();
  expect(await fs.readFile(resolveClientCredentialStorePath(liveEnv))).toEqual(liveClientBytes);
  expect(
    (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-migration-")),
  ).toEqual([]);
  expect(listOpenClawRegisteredAgentDatabases({ env: liveEnv })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agentId: "main" }),
      expect.objectContaining({ agentId: "runtime", path: runtimeDatabasePath }),
    ]),
  );
});

it.each([
  "identity",
  "token",
  "origin-token",
  "socket",
  "import-claim",
  "independent-source",
  "source-identity",
] as const)(
  "rejects unsupported staged client %s without publishing or retaining the stage",
  async (material) => {
    const { root, currentConfig } = fixture;
    fixture.install({
      mutateDuringApply: async (ctx) => {
        using credentials = openClientCredentialCustody(
          { OPENCLAW_STATE_DIR: ctx.stateDir },
          { migration: true },
        );
        expect(credentials).toBeDefined();
        const owner = credentials!;
        if (material === "identity") {
          owner.run({
            kind: "identity.create",
            identity: storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(42), 42),
          });
        } else if (material === "token" || material === "origin-token") {
          owner.run({
            kind: "token.replace",
            key: {
              device_id: "synthetic-device",
              role: "operator",
              ...(material === "origin-token" ? { gateway_scope: "https://example.invalid" } : {}),
            },
            token: {
              device_id: "synthetic-device",
              role: "operator",
              token: "synthetic-staged-token",
              scopes_json: '["operator.read"]',
              updated_at_ms: 42,
            },
          });
        } else if (material === "socket") {
          owner.run({
            kind: "socket.ensure",
            fallback: {
              socket_key: "current",
              socket_path: path.join(ctx.stateDir, "exec-approvals.sock"),
              socket_token: "synthetic-staged-socket",
              updated_at_ms: 42,
            },
          });
        } else {
          const stored = readClientCredentialReceipt(owner.database)!;
          const source = stored.receipt.source;
          assert(source, "missing staged bootstrap provenance");
          switch (material) {
            case "import-claim":
              stored.receipt.legacyImports["auth:primary"] = { sha256: null };
              break;
            case "independent-source":
              source.kind = "independent";
              source.engine = "native-v0";
              break;
            case "source-identity":
              source.identity += ":foreign";
              break;
          }
          runSqliteImmediateTransactionSync(owner.database, () =>
            writeClientCredentialReceipt(owner.database, stored.receipt, stored.phase),
          );
        }
      },
    });

    await expect(fixture.run()).rejects.toThrow("unsupported staged client credentials");
    expect(currentConfig.value).toEqual({});
    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, "openclaw-state", "client", "credentials.sqlite")),
    ).rejects.toThrow();
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-migration-")),
    ).toEqual([]);
  },
);

it("routes deferred writes through the canonical runtime and retries only failed activations", async () => {
  const { root } = fixture;
  const activationCalls: string[] = [];
  const installDeferred = (retry: boolean) =>
    fixture.install({
      deferred: true,
      deferredItemIds: ["plugin:calendar", "plugin:drive"],
      onDeferredApply: async (itemId, ctx) => {
        activationCalls.push(itemId);
        expect(await fixture.memory()).toBe("remember this\n");
        if (itemId === "plugin:calendar") {
          await mutateConfig(ctx, (draft) => {
            draft.gateway = { ...draft.gateway, port: 23456 };
          });
        }
        return retry || itemId === "plugin:calendar" ? "migrated" : "error";
      },
    });
  const initialProvider = installDeferred(false);
  const plan = vi.fn(initialProvider.plan);
  mocks.provider = { ...initialProvider, plan };
  await expect(fixture.run()).resolves.toEqual({
    kind: "no-imported-inference",
  });
  expect(activationCalls).toEqual(["plugin:calendar", "plugin:drive"]);
  expect(mocks.canonicalMutateConfigFile).toHaveBeenCalledOnce();
  expect(fixture.currentConfig.value).toMatchObject({ gateway: { port: 23456 } });
  const initialReport = (await readImportReport(root)).report;
  expect(initialReport.items.filter((item) => item.id === "plugin:drive")).toMatchObject([
    { status: "warning" },
  ]);
  expect(initialReport.warnings?.join("\n")).toContain(
    "Retry only those steps with openclaw onboard --flow import --import-from claude",
  );
  expect(JSON.stringify(initialReport)).not.toContain(".openclaw-migration-");
  installDeferred(true).plan = plan;
  await expect(fixture.run()).resolves.toEqual({
    kind: "no-imported-inference",
  });
  expect(plan).toHaveBeenCalledOnce();
  expect(mocks.canonicalMutateConfigFile).toHaveBeenCalledOnce();
  expect(activationCalls).toEqual(["plugin:calendar", "plugin:drive", "plugin:drive"]);
  expect(await fixture.memory()).toBe("remember this\n");
  const { report, journal } = await readImportReport(root);
  expect(
    ["plugin:calendar", "plugin:drive"].map(
      (id) => report.items.find((item) => item.id === id)?.status,
    ),
  ).toEqual(["migrated", "migrated"]);
  expect(report.warnings?.join("\n")).not.toContain("Retry only those steps");
  expect(journal.status).toBe("completed");
});
