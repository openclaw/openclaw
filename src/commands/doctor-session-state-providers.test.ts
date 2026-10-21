import fsSync from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
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

const owners = [
  ["codex", "Codex", ["codex", "codex-cli", "openai-codex"], ["codex", "codex-cli"], ["codex-cli"]],
  ["openai", "OpenAI", ["openai"], undefined, undefined],
  ["anthropic", "Anthropic", ["anthropic", "claude-cli"], ["claude-cli"], ["claude-cli"]],
] as const;
const routeOwners = owners.map(([id, label, providerIds, runtimeIds, cliSessionKeys]) => ({
  id,
  label,
  providerIds,
  runtimeIds,
  cliSessionKeys,
  authProfilePrefixes: providerIds.map((provider) => `${provider}:`),
}));
const codexOwner = routeOwners[0]!;
const anthropicOwner = routeOwners[2]!;
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

vi.mock("../plugins/doctor-contract-registry.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  )),
  listPluginDoctorSessionRouteStateOwners: vi.fn(() => ownerState.owners),
}));

async function runDoctor(params: {
  agentId?: string;
  cfg?: OpenClawConfig;
  store: Record<string, SessionEntry>;
  sqliteAgentId?: string;
}) {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const agentId = params.sqliteAgentId;
  const scope = { agentId, defaultAgentId: agentId, storePath };
  if (agentId) {
    for (const [sessionKey, row] of Object.entries(params.store)) {
      await upsertSessionEntryCore({ ...scope, sessionKey }, row);
    }
  } else {
    fsSync.writeFileSync(storePath, JSON.stringify(params.store));
  }
  const store = agentId
    ? {
        kind: "sqlite" as const,
        agentId,
        path: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
      }
    : { kind: "legacy" as const, path: storePath };
  const warnings: string[] = [];
  const changes: string[] = [];
  const confirmRuntimeRepair = vi.fn(async () => true);
  const scanner = createPluginSessionStateDoctorScanner({
    agentId: params.agentId,
    cfg: params.cfg ?? {},
    env: {},
  });
  Object.entries(params.store).forEach(([key, row]) => scanner.scanEntry(key, row));
  await runPluginSessionStateDoctorRepairs({
    scan: await scanner.result(),
    store,
    prompter: { confirmRuntimeRepair },
    warnings,
    changes,
  });
  return {
    store: agentId
      ? Object.fromEntries(
          Object.keys(params.store).map((sessionKey): [string, SessionEntry | undefined] => [
            sessionKey,
            loadSessionEntryReadOnly({ agentId, sessionKey, storePath: store.path }),
          ]),
        )
      : (JSON.parse(fsSync.readFileSync(store.path, "utf8")) as Record<string, SessionEntry>),
    legacyStorePath: storePath,
    warnings,
    changes,
    confirmRuntimeRepair,
  };
}

function entry(patch: Record<string, unknown>): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...patch } as SessionEntry;
}

function modelConfig(primary: string, fallbacks?: string[]): OpenClawConfig {
  return { agents: { defaults: { model: { primary, ...(fallbacks ? { fallbacks } : {}) } } } };
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

beforeEach(() => {
  ownerState.owners = routeOwners.slice(0, 2);
  Object.assign(runtimeState, { registered: true, supported: true, cliBackends: [] });
});

it("skips unrelated recovery metadata and valid locked harness rows", async () => {
  const store = {
    "agent:main:subagent:wedged-child": entry({
      abortedLastRun: true,
      subagentRecovery: { wedgedReason: "blocked" },
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
  expect(result).toMatchObject({ warnings: [], changes: [] });
  expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
});

it.each([
  {},
  {
    cliSessionBindings: { "claude-cli": { sessionId: "Canonical-ID" } },
    cliSessionIds: { "claude-cli": "Map-ID" },
  },
])("clears conversation state without leaving a migration source (%j)", async (binding) => {
  ownerState.owners = [anthropicOwner];
  const result = await runEntry(
    entry({ ...binding, claudeCliSessionId: "Obsolete-ID" }),
    modelConfig("openai/gpt-5.5"),
  );

  expect(result.row?.sessionId).toBe("session-1");
  expect([
    result.row?.claudeCliSessionId,
    result.row?.cliSessionBindings?.["claude-cli"],
    result.row?.cliSessionIds?.["claude-cli"],
  ]).toEqual([undefined, undefined, undefined]);
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

it("clears a genuinely stale owner model claude-cli/team/model", async () => {
  ownerState.owners = [anthropicOwner];
  const result = await runEntry(
    entry({
      model: "claude-cli/team/model",
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
});

it("repairs a non-default SQLite row without creating a legacy store", async () => {
  const sessionKey = "agent:ops:telegram:direct:2";
  const cfg = modelConfig("github-copilot/gpt-5-mini");
  cfg.agents!.entries = { main: {}, ops: {} };
  const result = await runDoctor({
    sqliteAgentId: "ops",
    cfg,
    store: { [sessionKey]: codexEntry({ agentHarnessId: undefined }) },
  });
  for (const key of ["providerOverride", "modelOverride", "modelProvider"] as const) {
    expect(result.store[sessionKey]?.[key]).toBeUndefined();
  }
  expect(fsSync.existsSync(result.legacyStorePath)).toBe(false);
});

it.each([
  ["available harness", "openai", "codex", "gpt-5.4", true],
  ["uninstalled harness", "openai", "codex", "gpt-5.4", false],
  ["unsupported harness", "openai", "codex", "gpt-5.4", false],
  ["CLI", "anthropic", "claude-cli", "claude-sonnet-4-6", true],
  ["CLI", "google", "google-gemini-cli", "gemini-2.5-pro", true],
  ["CLI", "anthropic", "claude-cli", "claude-sonnet-4-6", false],
] as const)(
  "%s preserves model %s/%s (%s), runtime available=%s",
  async (kind, provider, runtime, model, available) => {
    const cli = kind === "CLI";
    runtimeState.registered = !cli && kind !== "uninstalled harness";
    runtimeState.supported = kind !== "unsupported harness";
    const cfg = modelConfig("openai/gpt-5.4");
    if (cli) {
      ownerState.owners = [
        { id: provider, label: provider, providerIds: [provider], runtimeIds: [runtime] },
      ];
      runtimeState.cliBackends = available ? [{ id: runtime, modelProvider: provider }] : [];
    } else {
      cfg.agents!.defaults!.models = { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } };
    }
    const modelChoice = {
      providerOverride: provider,
      modelOverride: model,
      modelOverrideSource: "user" as const,
      ...(!cli ? { archived: true } : {}),
    };
    const selected = entry({ ...modelChoice, agentRuntimeOverride: runtime });
    const result = await runEntry(selected, cfg);
    if (available) {
      expect(result.row).toEqual(selected);
      if (!cli) {
        expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
      }
    } else {
      expect(result.row).not.toHaveProperty("agentRuntimeOverride");
      expect(result.row).toMatchObject(modelChoice);
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

it.each(["user", "configured"] as const)("preserves %s owner model choices", async (choice) => {
  const selected = codexEntry({ modelOverrideSource: choice === "user" ? "user" : "auto" });
  const result = await runEntry(
    selected,
    modelConfig(
      "github-copilot/gpt-5-mini",
      choice === "configured" ? ["openai-codex/gpt-5.4"] : undefined,
    ),
  );
  if (choice === "user") {
    expect(result.store).toEqual({ [result.key]: selected });
    expect(result.warnings.join("\n")).toContain("explicit Codex model overrides");
    expect(result.confirmRuntimeRepair).not.toHaveBeenCalled();
  } else {
    expect(result.row).toMatchObject({
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelProvider: "openai-codex",
    });
    expect(result.row?.agentHarnessId).toBeUndefined();
  }
});
