import { describe, expect, it, vi } from "vitest";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { collectChangedPaths } from "./config-change-paths.js";
import { applyUnsetPathsForWrite } from "./config-path-mutation.js";
import { createConfigValidationFailedError } from "./io.write-errors.js";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import { tryResolveLegacyCompatibilityAgentId } from "./legacy.default-agent-owner.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.js";

vi.unmock("../agents/agent-scope-config.js");

type PersistInput = Parameters<typeof resolvePersistCandidateForWrite>[0];
type WriteCase = {
  current: unknown;
  next?: unknown;
  source?: unknown;
  authored?: unknown;
  before?: unknown;
  options?: Partial<PersistInput>;
  expected?: unknown;
  error?: string;
};

const main = { default: true };
const mainDir = { ...main, agentDir: "/srv/main" };
const mainWorkspace = { ...main, workspace: "/srv/main" };
const mainIdentity = { ...main, identity: { name: "Main", emoji: "🦞" } };
const includedIdentity = { ...main, identity: { $include: "./identity.json" } };
const worker = { workspace: "/srv/worker" };
const roster = (entries: Record<string, unknown>) => ({ agents: { entries } });
const listRoster = (list: unknown[]) => ({ agents: { list } });
const legacyRoster = (...entries: [string, object][]) =>
  listRoster(entries.map(([id, entry]) => Object.assign({ id }, entry)));
const legacyMain = (entry = main, id = "main") => listRoster([{ id, ...entry }]);
const legacyWorker = (workspace: string, id = "worker") => listRoster([{ id, workspace }]);
const tools = (allow: string[]) => roster({ main: { ...main, tools: { allow } } });
const paths = (...values: string[]) => values.map((value) => value.split("."));
const fallbacks = (values: unknown[]) => withDefaults({ model: { fallbacks: values } });
const pluginPaths = (values: unknown[]) => ({ plugins: { load: { paths: values } } });
const explicitRoster = <T>(entries: T) => ({ agents: { ownership: "explicit", entries } });
const includedAgents = (agents: Record<string, unknown>) => ({
  agents: { $include: "./agents.json", ...agents },
});
const gatewayInclude = (auth: object) => ({
  gateway: { $include: "./config/gateway.json", auth },
});
const localGateway = (config: object, port?: number) => ({
  ...config,
  gateway: { mode: "local", ...(port === undefined ? {} : { port }) },
});
const legacySet = (value: unknown, field?: string, removals?: string[]): Partial<PersistInput> => ({
  explicitSetPaths: [["agents", "list", ...(field ? ["0", field] : [])]],
  explicitSetValueSource: value,
  ...(removals ? { allowedAgentRosterRemovals: removals } : {}),
});
const tony = { workspace: "/w/tony" };
const ops = { workspace: "/w/ops" };
const rootWorker = { workspace: "/w/worker" };
const tonyInclude = { $include: "./tony.json5" };
const opsInclude = { $include: "./ops.json5" };
const keyedTonyInclude = [["agents", "entries", "tony"]];
const identityRef = { source: "env", provider: "default", id: "SSH_IDENTITY" };
const secretEntry = (identityData: unknown) => ({ ...main, sandbox: { ssh: { identityData } } });
const runtimeSecretEntry = secretEntry("resolved-private-key");
const authoredSecretEntry = secretEntry(identityRef);

const withDefaults = (defaults: Record<string, unknown>) => ({ agents: { defaults } });
const withModels = (models: Record<string, unknown>) => withDefaults({ models });
const providerModels = (models: Record<string, unknown>[]) => ({
  models: { providers: { openai: { models } } },
});
const providerModelSource = providerModels([{ id: "gpt-5.5" }]);
const providerModelRuntime = providerModels([{ id: "gpt-5.5", contextWindow: 128000 }]);
const zeroTemperature = withDefaults({ params: { temperature: 0 } });
const retiredModel = "google/gemini-3-pro-preview";
const canonicalModel = "google/gemini-3.1-pro-preview";
const geminiEntry = { alias: "Gemini", params: { temperature: 0.2 } };
const providerParams = { transport: "sse", openaiWsWarmup: false };
const providerDefaults = {
  params: providerParams,
  models: { "openai/gpt-5.4": { alias: "GPT", params: providerParams } },
};
const selectedModel = (id: string, models: Record<string, unknown>) =>
  withDefaults({
    model: { primary: id, fallbacks: ["custom/model"] },
    models: { ...models, "custom/model": { alias: "Control" } },
  });
const selectedGemini = (id: string) =>
  selectedModel(id, { [id]: { alias: "Selected", params: thinkingParams } });
const scopedModelMaps = (id: string, phase: string) => ({
  agents: {
    defaults: {
      models: { [id]: { alias: `Default ${phase}`, agentRuntime: { id: "codex" } } },
    },
    entries: { ops: { models: { [id]: { alias: `Ops ${phase}` } } } },
  },
});
const legacyRoute = withDefaults({
  model: "openai-codex/gpt-5.5",
  models: { "openai-codex/gpt-5.5": { params: { reasoning_effort: "high" } } },
});
const repairedRoute = withDefaults({
  model: "openai/gpt-5.5",
  models: {
    "openai/gpt-5.5": { params: { reasoning_effort: "high" }, agentRuntime: { id: "codex" } },
  },
});
const rootModel = { primary: "fixture/primary", fallbacks: ["fixture/root"] };
const thinkingParams = { thinking: { level: "high" } };
const legacyResearch = (first: string, second: string) =>
  legacyRoster(
    ...[first, second].map((workspace): [string, object] => [
      "Research",
      { workspace, memorySearch: { enabled: false } },
    ]),
  );
const migratedResearch = (first: string, second: string) =>
  roster({
    research: { workspace: first, memory: { search: { enabled: false } } },
    "research-2": { workspace: second, memory: { search: { enabled: false } } },
  });

const writeCases: Record<string, WriteCase> = {
  "rejects a canonical roster rewrite that silently drops an entry": {
    current: roster({ main, worker }),
    next: roster({ worker }),
    error: "Config write would drop agent roster entries without an explicit deletion: main.",
  },
  "preserves an unchanged env-backed default during an unrelated roster addition": {
    current: roster({ main: mainDir }),
    authored: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" } }),
    next: roster({ main: mainDir, worker }),
    expected: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" }, worker }),
  },
  "honors explicit legacy-list leaves under an env-resolved agent id": {
    current: roster({ main: mainDir }),
    before: legacyMain(mainDir),
    authored: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${MAIN_AGENT_DIR}" }]),
    options: legacySet(legacyMain(mainDir, "${AGENT_ID}"), "agentDir"),
  },
  "rejects a whole-list write with an unmappable new env-backed id": {
    current: roster({ main }),
    before: legacyMain(),
    authored: legacyMain(),
    next: roster({ main, worker: { workspace: "/resolved/worker" } }),
    options: legacySet(
      legacyRoster(["main", main], ["${WORKER_ID}", { workspace: "${WORKER_DIR}" }]),
    ),
    error: "cannot safely resolve an explicitly replaced agent list slot",
  },
  "preserves an entry-internal include authored in a legacy list while adding an agent": {
    current: roster({ main: mainIdentity }),
    before: legacyMain(mainIdentity),
    authored: legacyMain(includedIdentity),
    next: roster({ main: mainIdentity, worker }),
    expected: roster({ main: includedIdentity, worker }),
  },
  "preserves authored references when an agent id is renamed": {
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    before: legacyMain(authoredSecretEntry),
    authored: legacyMain(authoredSecretEntry),
    next: roster({ primary: runtimeSecretEntry }),
    options: legacySet(legacyMain(runtimeSecretEntry, "primary"), "id", ["main"]),
    expected: roster({ primary: authoredSecretEntry }),
  },
  "applies a legacy-list unset to the renamed canonical entry": {
    current: roster({ main: mainWorkspace }),
    before: legacyMain(mainWorkspace),
    authored: legacyMain(mainWorkspace),
    next: roster({ primary: main }),
    options: {
      ...legacySet(legacyMain(main, "primary"), "id", ["main"]),
      unsetPaths: paths("agents.list.0.workspace"),
    },
  },
  "removes the explicitly reordered list slot instead of the surviving agent": {
    current: roster({ main, "0": worker }),
    source: legacyRoster(["main", main], ["0", worker]),
    authored: legacyRoster(["main", main], ["0", worker]),
    next: roster({ main }),
    options: {
      ...legacySet(legacyRoster(["0", worker], ["main", main]), undefined, ["0"]),
      unsetPaths: paths("agents.list.0"),
    },
  },
  "rejects an indexed unset across duplicate explicit list ids": {
    current: roster({ worker: { workspace: "/old" } }),
    source: legacyWorker("/old"),
    before: legacyWorker("/old"),
    authored: legacyWorker("/old", "${WORKER_ID}"),
    next: roster({ worker: { workspace: "/second" } }),
    options: {
      ...legacySet(
        listRoster([
          { id: "${WORKER_ID}", workspace: "/first" },
          { id: "worker", workspace: "/second" },
        ]),
      ),
      unsetPaths: paths("agents.list.0"),
    },
    error: 'cannot canonicalize duplicate normalized agent id "worker"',
  },
  "rejects ambiguous one-for-one replacements with authored references": {
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    authored: roster({ main: authoredSecretEntry }),
    next: roster({ worker: { ...main, ...worker } }),
    error: "cannot safely match renamed agent entries",
  },
  "preserves each duplicate legacy occurrence through compound migrations": {
    current: legacyResearch("/srv/shared", "/srv/shared"),
    authored: legacyResearch("${FIRST_WORKSPACE}", "${SECOND_WORKSPACE}"),
    next: migratedResearch("/srv/shared", "/srv/shared"),
    expected: migratedResearch("${FIRST_WORKSPACE}", "${SECOND_WORKSPACE}"),
  },
  "preserves authored references when roster arrays shift": {
    current: tools(["read", "old"]),
    authored: tools(["${PRIMARY_TOOL}", "old"]),
    next: tools(["new", "read", "old"]),
    expected: tools(["new", "${PRIMARY_TOOL}", "old"]),
  },
  "does not reuse an authored array reference after its source element was consumed": {
    current: tools(["a", "b"]),
    authored: tools(["${TOOL_A}", "${TOOL_B}"]),
    next: tools(["b", "b"]),
    expected: tools(["${TOOL_B}", "b"]),
  },
  "rejects unsetting an id inside a legacy list entry": {
    current: roster({ main }),
    authored: legacyMain(),
    next: roster({ main }),
    options: { unsetPaths: paths("agents.list.0.id") },
    error: "cannot unset an agent id",
  },
  "allows roster writes beside unrelated root includes using pre-migration provenance": {
    current: roster({ main }),
    before: { channels: { telegram: { enabled: true } } },
    authored: { $include: "./channels.json" },
    next: roster({ main, worker }),
    expected: { $include: "./channels.json", ...roster({ main, worker }) },
  },
  "preserves multiple keyed entry includes while adding one root-owned agent": {
    current: explicitRoster({ tony, ops }),
    authored: explicitRoster({ tony: tonyInclude, ops: opsInclude }),
    next: explicitRoster({ tony, ops, worker: rootWorker }),
    options: { keyedAgentEntryIncludePaths: [...keyedTonyInclude, ["agents", "entries", "ops"]] },
    expected: explicitRoster({ tony: tonyInclude, ops: opsInclude, worker: rootWorker }),
  },
  "rejects an agents.entries include while adding a root-owned agent": {
    current: explicitRoster({ tony }),
    authored: explicitRoster({ $include: "./agents.json5" }),
    next: explicitRoster({ tony, worker: rootWorker }),
    error: "Config write would flatten $include-owned config at agents",
  },
  "rejects deleting a keyed entry include while adding a root-owned agent": {
    current: explicitRoster({ tony }),
    authored: explicitRoster({ tony: tonyInclude }),
    next: explicitRoster({ worker: rootWorker }),
    options: {
      allowedAgentRosterRemovals: ["tony"],
      keyedAgentEntryIncludePaths: keyedTonyInclude,
    },
    error: "Config write would flatten $include-owned config at agents.entries.tony",
  },
  "allows nested root-authored sibling edits without flattening included values": {
    current: { gateway: { mode: "local", auth: { mode: "token", token: "old" } } },
    authored: gatewayInclude({ token: "old" }),
    next: { gateway: { mode: "local", auth: { mode: "none", token: "new", strategy: "strict" } } },
    expected: gatewayInclude({ token: "new", mode: "none", strategy: "strict" }),
  },
  "rejects included-value edits beside root-authored sibling edits": {
    current: { gateway: { mode: "local", legacyKey: "old" } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: "old" } },
    next: { gateway: { mode: "remote", legacyKey: "new" } },
    error: "Config write would flatten $include-owned config at gateway",
  },
  "allows root-array replacement beside an include": {
    current: withDefaults({ model: rootModel, maxConcurrent: 16 }),
    source: withDefaults({ model: rootModel }),
    authored: includedAgents(fallbacks(["fixture/root"]).agents),
    next: withDefaults({
      model: { ...rootModel, fallbacks: ["fixture/replacement"] },
      maxConcurrent: 16,
    }),
    expected: includedAgents(fallbacks(["fixture/replacement"]).agents),
  },
  "does not infer array ownership from a normalized baseline that dropped included values": {
    before: fallbacks(["fixture/included", "fixture/root"]),
    current: fallbacks(["fixture/root"]),
    authored: includedAgents(fallbacks(["fixture/root"]).agents),
    next: fallbacks([]),
    error: "Config write would flatten $include-owned config at agents",
  },
  "rejects replacing root arrays that contain nested includes": {
    before: fallbacks(["fixture/root"]),
    current: fallbacks(["fixture/root"]),
    authored: includedAgents(fallbacks([{ $include: "./fallback.json" }]).agents),
    next: fallbacks([]),
    error: "Config write would flatten $include-owned config at agents",
  },
  "preserves include-owned array entries across runtime-only normalization": {
    current: localGateway(listRoster([{ id: "main", workspace: "/home/test/agent" }])),
    source: localGateway(listRoster([{ id: "main", workspace: "~/agent" }])),
    authored: localGateway(listRoster([{ $include: "./config/main-agent.json" }])),
    next: localGateway(listRoster([{ id: "main", workspace: "~/agent" }]), 18789),
    expected: localGateway(listRoster([{ $include: "./config/main-agent.json" }]), 18789),
  },
  "allows unrelated removals after duplicate include-resolved values": {
    current: pluginPaths(["/same", "/same", "/other"]),
    authored: pluginPaths([{ $include: "./path.json5" }, "/same", "/other"]),
    next: pluginPaths(["/same", "/same"]),
    expected: pluginPaths([{ $include: "./path.json5" }, "/same"]),
  },
  "rejects included-entry removals hidden by duplicate sibling edits": {
    current: pluginPaths(["/same", "/same", "/old"]),
    authored: pluginPaths([{ $include: "./path.json5" }, "/same", "/old"]),
    next: pluginPaths(["/same", "/new"]),
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  "rejects newly introduced duplicates of include-owned array entries": {
    current: pluginPaths(["/root", "/included"]),
    authored: pluginPaths(["/root", { $include: "./path.json5" }]),
    next: pluginPaths(["/included", "/included"]),
    error: "Config write would flatten $include-owned config at plugins.load.paths.1",
  },
  "preserves authored agent provider params during narrowed agent-list writes": {
    current: localGateway({
      agents: { defaults: { ...providerDefaults, maxConcurrent: 4 }, list: [{ id: "main" }] },
    }),
    source: localGateway({ agents: { defaults: providerDefaults, list: [{ id: "main" }] } }),
    next: localGateway(listRoster([{ id: "main" }, { id: "ops" }])),
    expected: localGateway({
      agents: { defaults: providerDefaults, entries: { main: {}, ops: {} } },
    }),
  },
  "preserves separate authored model params when writing a retired model": {
    source: selectedGemini(retiredModel),
    current: selectedGemini(canonicalModel),
    next: selectedModel(canonicalModel, { [canonicalModel]: {} }),
    expected: selectedModel(retiredModel, { [canonicalModel]: { params: thinkingParams } }),
  },
  "canonicalizes only agent model maps touched through normalized runtime identities": {
    source: scopedModelMaps(retiredModel, "before"),
    current: scopedModelMaps(canonicalModel, "before"),
    next: scopedModelMaps(canonicalModel, "after"),
  },
  "canonicalizes an explicitly persisted model-map path even when runtime values are equal": {
    source: withModels({ [retiredModel]: geminiEntry }),
    current: withModels({ [canonicalModel]: geminiEntry }),
    options: { explicitSetPaths: [["agents", "defaults", "models"]] },
  },
  "does not reintroduce legacy openai-codex model params after doctor route repair": {
    current: legacyRoute,
    next: repairedRoute,
  },
  "allows explicit unsets to remove authored agent provider params": {
    current: withDefaults({
      params: providerParams,
      models: { "openai/gpt-5.4": { params: providerParams } },
    }),
    next: withModels({ "openai/gpt-5.4": {} }),
    options: {
      unsetPaths: [
        ["agents", "defaults", "params"],
        ["agents", "defaults", "models", "openai/gpt-5.4", "params"],
      ],
    },
  },
  "ignores unsafe array-index explicit set paths": {
    current: providerModelRuntime,
    source: providerModelSource,
    next: providerModelSource,
    options: {
      explicitSetValueSource: providerModelRuntime,
      explicitSetPaths: paths(
        ...["0abc", "+0", "9007199254740993", "4294967294"].map(
          (index) => `models.providers.openai.models.${index}.contextWindow`,
        ),
      ),
    },
  },
  "rejects default-valued explicit writes under include-owned paths": {
    current: zeroTemperature,
    source: withDefaults({}),
    authored: withDefaults({ $include: "./agents-defaults.json" }),
    next: withDefaults({}),
    options: {
      explicitSetValueSource: zeroTemperature,
      explicitSetPaths: paths("agents.defaults.params"),
    },
    error: "Config write would flatten $include-owned config at agents.defaults",
  },
};

function resolveWriteCase(testCase: WriteCase): unknown {
  return resolvePersistCandidateForWrite({
    runtimeConfig: testCase.current,
    sourceConfig: testCase.source ?? testCase.current,
    nextConfig: testCase.next ?? testCase.current,
    rootAuthoredConfig: testCase.authored,
    sourceConfigBeforeMigrations: testCase.before,
    ...testCase.options,
  });
}

describe("config io write prepare", () => {
  for (const [name, testCase] of Object.entries(writeCases)) {
    it(name, () => {
      if (testCase.error) {
        expect(() => resolveWriteCase(testCase)).toThrow(testCase.error);
        return;
      }
      const expected = structuredClone(testCase.expected ?? testCase.next ?? testCase.current);
      expect(resolveWriteCase(testCase)).toEqual(expected);
    });
  }

  it("preserves explicit sibling intent beside an agents include", () => {
    const authoredAgents = explicitRoster({ main: {}, spare: {} }).agents;
    const rootAuthoredConfig = { agents: { $include: "./base.json", ...authoredAgents } };
    const sourceConfig = {
      agents: { ...authoredAgents, defaults: { model: { primary: "fixture/primary" } } },
    };
    const runtimeConfig = {
      commands: { restart: true },
      agents: {
        ...sourceConfig.agents,
        defaults: { ...sourceConfig.agents.defaults, maxConcurrent: 16 },
      },
    };
    const entries = { ...authoredAgents.entries, worker: {} };
    expect(
      resolveWriteCase({
        source: sourceConfig,
        authored: rootAuthoredConfig,
        current: runtimeConfig,
        next: { ...runtimeConfig, agents: { ...runtimeConfig.agents, entries } },
        options: {
          explicitSetPaths: paths(
            "agents.entries",
            "agents.defaults.maxConcurrent",
            "commands.restart",
          ),
          allowIncludeAncestorExplicitSetPaths: true,
        },
      }),
    ).toEqual({
      ...rootAuthoredConfig,
      commands: { restart: true },
      agents: {
        ...rootAuthoredConfig.agents,
        entries,
        defaults: { maxConcurrent: 16 },
      },
    });
  });

  it.each([
    ["included", "parent", ["included"], undefined],
    ["included", "index", ["included"], undefined],
    ["mixed", "parent", ["included", "root"], ["root"]],
    ["root-owned", "index", ["root"], ["root"]],
  ] as const)(
    "checks %s array ownership for explicit %s writes",
    (_name, kind, resolved, authored) => {
      const sourceConfig = {
        agents: { ...fallbacks([...resolved]).agents, entries: { main: {} } },
      };
      const persisted = resolveWriteCase({
        current: sourceConfig,
        before: sourceConfig,
        authored: includedAgents({
          entries: { main: {} },
          ...(authored ? fallbacks([...authored]).agents : {}),
        }),
        next: { agents: { ...sourceConfig.agents, entries: { main: {}, worker: {} } } },
        options: {
          explicitSetPaths: [
            ["agents", "entries"],
            kind === "parent"
              ? ["agents", "defaults"]
              : ["agents", "defaults", "model", "fallbacks", String(resolved.length - 1)],
          ],
          allowIncludeAncestorExplicitSetPaths: true,
        },
      });
      expect(persisted).toMatchObject(includedAgents({ entries: { main: {}, worker: {} } }));
      if (authored === undefined) {
        expect(persisted).not.toHaveProperty("agents.defaults.model.fallbacks");
      } else {
        expect(persisted).toHaveProperty("agents.defaults.model.fallbacks", [...authored]);
      }
    },
  );

  it("uses recorded facts instead of placeholder-shaped roster bytes", () => {
    const literalId = "${AGENT_ID}";
    const sourceConfigBeforeMigrations = listRoster([{ id: literalId, ...main }]);
    const resolveRename = () =>
      resolveWriteCase({
        current: roster({ [literalId]: main }),
        before: sourceConfigBeforeMigrations,
        authored: legacyMain(main, literalId),
        next: roster({ renamed: main }),
        options: legacySet(legacyMain(main, "renamed"), "id", [literalId]),
      });

    setConfigResolutionFacts(sourceConfigBeforeMigrations, new Set(["agents.list[0].id"]));
    expect(resolveRename).toThrow("cannot safely resolve an env-backed renamed agent id");

    setConfigResolutionFacts(sourceConfigBeforeMigrations, new Set());
    expect(resolveRename()).toEqual(roster({ renamed: main }));
  });

  it("preserves an untouched legacy owner marker across a partial unrelated write", () => {
    const authored = {
      agents: { entries: { ops: {}, research: { default: true } } },
      gateway: { port: 18789 },
    };
    const migrated = createCanonicalAgentConfigFixture(authored).config;

    const persisted = resolveWriteCase({
      current: migrated,
      before: authored,
      authored,
      next: { gateway: { port: 19001 } },
      options: {
        preserveLegacyAgentRoster: true,
        explicitSetPaths: [["gateway", "port"]],
        explicitSetValueSource: { gateway: { port: 19001 } },
      },
    });

    expect(persisted).toHaveProperty("agents.entries.research.default", true);
    const reloaded = createCanonicalAgentConfigFixture(persisted).config;
    expect(tryResolveLegacyCompatibilityAgentId(reloaded)).toBe("research");
  });

  it("omits canonical entries when the complete legacy list is unset", () => {
    const unsetPaths = [["agents", "list"]];
    const persisted = applyUnsetPathsForWrite(
      resolveWriteCase({
        current: roster({ main }),
        authored: legacyMain(),
        next: roster({ main }),
        options: {
          unsetPaths,
          allowedAgentRosterRemovals: ["main"],
        },
      }),
      unsetPaths,
    );
    expect(persisted).not.toHaveProperty("agents.list");
    expect(persisted).not.toHaveProperty("agents.entries");
  });

  it("prunes empty objects inside arrays during explicit unsets", () => {
    const input = {
      plugins: {
        entries: { example: { config: { values: [{ value: "remove" }, { value: "keep" }] } } },
      },
    };
    const before = structuredClone(input);
    expect(
      applyUnsetPathsForWrite(input, [
        ["plugins", "entries", "example", "config", "values", "0", "value"],
      ]),
    ).toEqual({
      plugins: { entries: { example: { config: { values: [{ value: "keep" }] } } } },
    });
    expect(input).toEqual(before);
  });

  it.each([
    ["invalid array suffix", ["tools", "alsoAllow", "1abc"]],
    ["prototype key", ["commands", "__proto__"]],
  ] as const)("treats %s unset paths as immutable no-ops", (_name, unsetPath) => {
    const input: OpenClawConfig = {
      gateway: { mode: "local" },
      commands: { ownerDisplay: "hash" },
      tools: { alsoAllow: ["exec", "fetch"] },
    };
    expect(applyUnsetPathsForWrite(input, [[...unsetPath]])).toBe(input);
  });

  it('formats actionable guidance for dmPolicy="open" without wildcard allowFrom', () => {
    const message = createConfigValidationFailedError([
      {
        path: "channels.telegram.allowFrom",
        message:
          'channels.telegram.dmPolicy = "open" requires channels.telegram.allowFrom to include "*"',
      },
    ]).message;
    expect(message).toContain("openclaw config set channels.telegram.allowFrom '[\"*\"]'");
    expect(message).toContain('openclaw config set channels.telegram.dmPolicy "pairing"');
  });

  it("ignores prototype-chain keys when collecting changed paths", () => {
    const base = { safe: { mode: "local" }, collision: { mode: "owned-base" } };
    const target = Object.create({ collision: { mode: "inherited-target" } }) as Record<
      string,
      unknown
    >;
    target.safe = { mode: "cloud" };
    const changedPaths = new Set<string>();
    collectChangedPaths(base, target, "", changedPaths);
    expect([...changedPaths].toSorted()).toEqual(["collision", "safe.mode"]);
  });
});
