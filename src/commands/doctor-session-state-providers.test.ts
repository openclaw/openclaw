import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawAgentHarness } from "../agents/harness/builtin-openclaw.js";
import type * as RuntimePluginLoadPlan from "../agents/harness/runtime-plugin-load-plan.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type * as PluginLoader from "../plugins/loader.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  createPluginSessionStateDoctorScanner,
  runPluginSessionStateDoctorRepairs,
} from "./doctor-session-state-providers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-route-sqlite-");

const codexOwner = {
  id: "codex",
  label: "Codex",
  providerIds: ["codex", "codex-cli", "openai-codex"],
  runtimeIds: ["codex", "codex-cli"],
  cliSessionKeys: ["codex-cli"],
  authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
};
const openAIOwner = {
  id: "openai",
  label: "OpenAI",
  providerIds: ["openai"],
  authProfilePrefixes: ["openai:"],
};
const anthropicOwner = {
  id: "anthropic",
  label: "Anthropic",
  providerIds: ["anthropic", "claude-cli"],
  runtimeIds: ["claude-cli"],
  cliSessionKeys: ["claude-cli"],
  authProfilePrefixes: ["anthropic:", "claude-cli:"],
};
const ownerState = vi.hoisted(() => ({ owners: [] as Array<Record<string, unknown>> }));
const runtimeState = vi.hoisted(() => ({
  registered: true,
  supported: true,
  cliBackends: [] as Array<{ id: string; modelProvider: string }>,
}));

vi.mock("../agents/harness/runtime-plugin-load-plan.js", async () => ({
  ...(await vi.importActual<typeof RuntimePluginLoadPlan>(
    "../agents/harness/runtime-plugin-load-plan.js",
  )),
  resolveAgentRuntimePluginLoadPlan: ({ config }: { config: OpenClawConfig }) => ({
    config,
    pluginIds: ["codex", "anthropic", "google"],
  }),
}));

vi.mock("../plugins/loader.js", async () => ({
  ...(await vi.importActual<typeof PluginLoader>("../plugins/loader.js")),
  acquirePluginRegistryForInspection: async () => {
    const registry = createEmptyPluginRegistry();
    if (runtimeState.registered) {
      registry.agentHarnesses.push({
        pluginId: "codex",
        source: "test",
        harness: {
          ...createOpenClawAgentHarness(),
          id: "codex",
          supports: () => ({ supported: runtimeState.supported }),
        },
      });
    }
    for (const backend of runtimeState.cliBackends) {
      registry.cliBackends.push({
        pluginId: backend.modelProvider,
        source: "test",
        backend: { ...backend, config: { command: backend.id } },
      });
    }
    return { registry, release: async () => {} };
  },
}));

vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  );
  return {
    ...actual,
    listPluginDoctorSessionRouteStateOwners: vi.fn(() => ownerState.owners),
  };
});

async function runDoctor(params: {
  agentId?: string;
  cfg?: OpenClawConfig;
  store: Record<string, SessionEntry>;
  confirm?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const root = sessionDirs.make();
  const storePath = path.join(root, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(params.store), "utf8");
  const warnings: string[] = [];
  const changes: string[] = [];
  const confirmRuntimeRepair = vi.fn(async () => params.confirm ?? true);
  const scanner = createPluginSessionStateDoctorScanner({
    agentId: params.agentId,
    cfg: params.cfg ?? {},
    env: params.env ?? {},
  });
  for (const [sessionKey, sessionEntry] of Object.entries(params.store)) {
    scanner.scanEntry(sessionKey, sessionEntry);
  }
  await runPluginSessionStateDoctorRepairs({
    scan: await scanner.result(),
    store: { kind: "legacy", path: storePath },
    prompter: { confirmRuntimeRepair },
    warnings,
    changes,
  });
  return {
    store: JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, SessionEntry>,
    warnings,
    changes,
    confirmRuntimeRepair,
  };
}

function entry(patch: Record<string, unknown>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    ...patch,
  } as SessionEntry;
}

function modelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { model: { primary } } } };
}

function codexEntry(patch: Record<string, unknown> = {}) {
  return entry({
    providerOverride: "openai-codex",
    modelOverride: "gpt-5.4",
    modelOverrideSource: "auto",
    modelProvider: "openai-codex",
    model: "gpt-5.4",
    agentHarnessId: "codex",
    ...patch,
  });
}

async function runEntry(row: SessionEntry, cfg = modelConfig("github-copilot/gpt-5-mini")) {
  const key = "agent:main:telegram:direct:2";
  const result = await runDoctor({ cfg, store: { [key]: row } });
  return { ...result, key, row: result.store[key] };
}

describe("doctor session state provider routes", () => {
  beforeEach(() => {
    ownerState.owners = [codexOwner, openAIOwner];
    runtimeState.registered = true;
    runtimeState.supported = true;
    runtimeState.cliBackends = [];
  });

  it("skips unrelated recovery metadata and valid locked harness rows", async () => {
    const store = {
      "agent:main:subagent:wedged-child": entry({
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: 1,
          wedgedAt: 2,
          wedgedReason: "blocked",
        },
      }),
      "agent:main:ordinary-locked": entry({
        modelSelectionLocked: true,
        agentHarnessId: "codex",
        modelProvider: "openai",
        model: "gpt-5.5",
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        cliSessionBindings: { "codex-cli": { sessionId: "native-codex-session" } },
      }),
    };

    const result = await runDoctor({ store });

    expect(result.store).toEqual(store);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it.each([
    { label: "legacy-only", binding: {} },
    {
      label: "canonical and legacy",
      binding: {
        cliSessionBindings: { "claude-cli": { sessionId: "Canonical-ID" } },
        cliSessionIds: { "claude-cli": "Map-ID" },
      },
    },
  ])("clears $label conversation state without leaving a migration source", async ({ binding }) => {
    ownerState.owners = [anthropicOwner];
    const key = "agent:main:stale-claude";
    const result = await runDoctor({
      cfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      store: { [key]: entry({ ...binding, claudeCliSessionId: "Obsolete-ID" }) },
    });

    expect(result.store[key]?.sessionId).toBe("session-1");
    expect(result.store[key]?.claudeCliSessionId).toBeUndefined();
    expect(result.store[key]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(result.store[key]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(result.changes.join("\n")).toContain("Cleared stale Anthropic session routing state");
  });

  it("uses the inspected agent route for a store-local global session", async () => {
    const store = {
      global: entry({
        model: "gpt-5.4",
        modelProvider: "openai-codex",
        providerOverride: "openai-codex",
      }),
    };
    const cfg = {
      agents: {
        entries: {
          main: { model: "github-copilot/gpt-5.4-mini" },
          ops: { model: "openai/gpt-5.4" },
        },
      },
      models: {
        providers: {
          openai: {
            agentRuntime: { id: "codex-cli" },
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
      session: { scope: "global" },
    } satisfies OpenClawConfig;

    const result = await runDoctor({ agentId: "ops", cfg, store });

    expect(result.store).toEqual(store);
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("clears stale automatic owner state through the doctor repair boundary", async () => {
    const result = await runEntry(
      codexEntry({
        modelOverrideRouteResolution: "resolved",
        contextTokens: 1_050_000,
        systemPromptReport: { source: "run" },
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        cliSessionBindings: {
          "codex-cli": { sessionId: "codex-session" },
          "claude-cli": { sessionId: "claude-session" },
        },
      }),
    );

    expect(result.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(result.warnings.join("\n")).toContain("stale Codex session routing state");
    expect(result.changes.join("\n")).toContain("Cleared stale Codex session routing state");
    for (const key of [
      "providerOverride",
      "modelOverride",
      "modelOverrideRouteResolution",
      "modelProvider",
      "agentHarnessId",
      "authProfileOverride",
    ] as const) {
      expect(result.row?.[key]).toBeUndefined();
    }
    expect(result.row?.cliSessionBindings).toEqual({
      "claude-cli": { sessionId: "claude-session" },
    });
  });

  it.each([{ model: "claude-cli/team/model" }])(
    "clears a genuinely stale owner model $modelProvider/$model",
    async (runtimeModel) => {
      ownerState.owners = [anthropicOwner];
      const result = await runEntry(
        entry({
          ...runtimeModel,
          contextTokens: 128_000,
          authProfileOverride: "google:chosen",
          authProfileOverrideSource: "user",
        }),
        modelConfig("google/gemini-2.5-pro"),
      );

      expect(result.confirmRuntimeRepair).toHaveBeenCalledOnce();
      expect(result.warnings.join("\n")).toContain("runtime model state");
      expect(result.changes.join("\n")).toContain("Cleared stale Anthropic session routing state");
      expect(result.row).toEqual({
        sessionId: "session-1",
        updatedAt: expect.any(Number),
        delivery: { kind: "none" },
        authProfileOverride: "google:chosen",
        authProfileOverrideSource: "user",
      });
    },
  );

  it("repairs a non-default SQLite row without creating a legacy store", async () => {
    const root = sessionDirs.make();
    const legacyStorePath = path.join(root, "sessions.json");
    const sqliteStorePath = resolveSqliteTargetFromSessionStorePath(legacyStorePath, {
      agentId: "ops",
      defaultAgentId: "ops",
    }).path;
    const sessionKey = "agent:ops:telegram:direct:2";
    const staleEntry = codexEntry({ agentHarnessId: undefined });
    const cfg = {
      agents: {
        defaults: { model: { primary: "github-copilot/gpt-5-mini" } },
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;
    await upsertSessionEntryCore(
      {
        agentId: "ops",
        defaultAgentId: "ops",
        sessionKey,
        storePath: legacyStorePath,
      },
      staleEntry,
    );
    const scanner = createPluginSessionStateDoctorScanner({ cfg, env: {} });
    scanner.scanEntry(sessionKey, staleEntry);

    await runPluginSessionStateDoctorRepairs({
      scan: await scanner.result(),
      store: { kind: "sqlite", agentId: "ops", path: sqliteStorePath },
      prompter: { confirmRuntimeRepair: vi.fn(async () => true) },
      warnings: [],
      changes: [],
    });

    const repaired = loadSessionEntryReadOnly({
      agentId: "ops",
      sessionKey,
      storePath: sqliteStorePath,
    });
    for (const key of ["providerOverride", "modelOverride", "modelProvider"] as const) {
      expect(repaired?.[key]).toBeUndefined();
    }
    expect(fsSync.existsSync(legacyStorePath)).toBe(false);
  });

  it.each([
    { name: "available", registered: true, supported: true, kept: true },
    { name: "uninstalled", registered: false, supported: true, kept: false },
    { name: "invalid for the model", registered: true, supported: false, kept: false },
  ])("handles an explicit runtime that is $name without changing its model", async (state) => {
    runtimeState.registered = state.registered;
    runtimeState.supported = state.supported;
    const key = "agent:main:dashboard:explicit-runtime";
    const selected = entry({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      agentRuntimeOverride: "codex",
      archived: true,
    });
    const result = await runDoctor({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      store: { [key]: selected },
    });
    if (state.kept) {
      expect(result.store[key]).toEqual(selected);
      expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
    } else {
      expect(result.store[key]).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "user",
        archived: true,
      });
      expect(result.store[key]).not.toHaveProperty("agentRuntimeOverride");
    }
  });

  it.each([
    ["anthropic", "claude-cli", "claude-sonnet-4-6", true],
    ["google", "google-gemini-cli", "gemini-2.5-pro", true],
    ["anthropic", "claude-cli", "claude-sonnet-4-6", false],
  ] as const)(
    "preserves only available CLI owner %s/%s (%s, %s)",
    async (provider, runtime, model, available) => {
      ownerState.owners = [
        {
          id: provider,
          label: provider,
          providerIds: [provider],
          runtimeIds: [runtime],
        },
      ];
      runtimeState.registered = false;
      runtimeState.cliBackends = available ? [{ id: runtime, modelProvider: provider }] : [];
      const selected = entry({
        providerOverride: provider,
        modelOverride: model,
        modelOverrideSource: "user",
        agentRuntimeOverride: runtime,
      });
      const result = await runEntry(selected, modelConfig("openai/gpt-5.4"));
      if (available) {
        expect(result.row).toEqual(selected);
      } else {
        expect(result.row).not.toHaveProperty("agentRuntimeOverride");
        expect(result.row).toMatchObject({
          providerOverride: provider,
          modelOverride: model,
        });
      }
    },
  );

  it("clears ignored legacy claude-cli residue after switching to openai-codex", async () => {
    ownerState.owners = [codexOwner, anthropicOwner];
    const result = await runEntry(
      entry({
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentRuntimeOverride: "claude-cli",
      }),
      modelConfig("openai-codex/gpt-5.5"),
    );
    expect(result.row).not.toHaveProperty("agentRuntimeOverride");
  });

  it("leaves explicit user owner choices for manual review", async () => {
    const selected = codexEntry({ modelOverrideSource: "user" });
    const result = await runEntry(selected);
    expect(result.store).toEqual({ [result.key]: selected });
    expect(result.warnings.join("\n")).toContain("explicit Codex model overrides");
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("keeps configured owner model state while clearing a stale runtime pin", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5-mini",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runEntry(codexEntry(), cfg);
    expect(result.row).toMatchObject({
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelProvider: "openai-codex",
    });
    expect(result.row?.agentHarnessId).toBeUndefined();
  });
});
