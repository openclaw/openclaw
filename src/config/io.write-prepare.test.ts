// Covers canonical config writes, roster migration, include ownership, and authored env refs.
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
  name: string;
  current: unknown;
  next: unknown;
  source?: unknown;
  authored?: unknown;
  before?: unknown;
  options?: Partial<PersistInput>;
  expected?: unknown;
  error?: string;
};

const main = { default: true };
const worker = { workspace: "/srv/worker" };
const roster = (entries: Record<string, unknown>) => ({ agents: { entries } });
const listRoster = (list: unknown[]) => ({ agents: { list } });
const explicitRoster = (entries: unknown) => ({ agents: { ownership: "explicit", entries } });
const tony = { workspace: "/w/tony" };
const tonyInclude = { $include: "./tony.json5" };
const keyedTonyInclude = [["agents", "entries", "tony"]];
const identityRef = { source: "env", provider: "default", id: "SSH_IDENTITY" };
const runtimeSecretEntry = {
  default: true,
  sandbox: { ssh: { identityData: "resolved-private-key" } },
};
const authoredSecretEntry = {
  default: true,
  sandbox: { ssh: { identityData: identityRef } },
};

const withDefaults = (defaults: Record<string, unknown>) => ({ agents: { defaults } });
const withModels = (models: Record<string, unknown>) => withDefaults({ models });
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
const scopedModelMaps = (id: string, phase: string) => ({
  agents: {
    defaults: {
      models: { [id]: { alias: `Default ${phase}`, agentRuntime: { id: "codex" } } },
    },
    entries: { ops: { models: { [id]: { alias: `Ops ${phase}` } } } },
  },
});
const sharedModelSource = withModels({
  "google/gemini-3.1-pro": { alias: "Shorthand", params: { temperature: 0.2 } },
  [canonicalModel]: { alias: "Canonical", params: { topP: 0.8 } },
});
const sharedModelRuntime = withModels({
  [canonicalModel]: { alias: "Canonical", params: { temperature: 0.2, topP: 0.8 } },
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

const writeCases: WriteCase[] = [
  {
    name: "omits the unauthored parent after removing an injected roster",
    current: { gateway: { port: 18789 }, ...roster({ main: {} }) },
    authored: { gateway: { port: 18789 } },
    next: { gateway: { port: 19001 }, ...roster({ main: {} }) },
    expected: { gateway: { port: 19001 } },
  },
  {
    name: "retains an explicitly authored empty agents section",
    current: { gateway: { port: 18789 }, ...roster({ main: {} }) },
    authored: { gateway: { port: 18789 }, agents: {} },
    next: { gateway: { port: 19001 }, ...roster({ main: {} }) },
    expected: { gateway: { port: 19001 }, agents: {} },
  },
  {
    name: "rejects a canonical roster rewrite that silently drops an entry",
    current: roster({ main, worker }),
    next: roster({ worker }),
    error: "Config write would drop agent roster entries without an explicit deletion: main.",
  },
  {
    name: "uses the complete next roster when an unrelated explicit value source is present",
    current: roster({ main }),
    next: { ...roster({ main, worker }), gateway: { port: 19001 } },
    options: {
      explicitSetPaths: [["gateway", "port"]],
      explicitSetValueSource: { gateway: { port: 19001 } },
    },
    expected: { ...roster({ main, worker }), gateway: { port: 19001 } },
  },
  {
    name: "preserves an unchanged env-backed default during an unrelated roster addition",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    authored: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" } }),
    next: roster({ main: { ...main, agentDir: "/srv/main" }, worker }),
    expected: roster({ main: { default: "${MAIN_DEFAULT}", agentDir: "/srv/main" }, worker }),
  },
  {
    name: "honors an explicit roster leaf write that equals the resolved runtime value",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    authored: roster({ main: { ...main, agentDir: "${MAIN_AGENT_DIR}" } }),
    next: roster({ main: { ...main, agentDir: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "entries", "main", "agentDir"]],
      explicitSetValueSource: roster({ main: { ...main, agentDir: "/srv/main" } }),
    },
    expected: roster({ main: { ...main, agentDir: "/srv/main" } }),
  },
  {
    name: "honors explicit legacy-list leaves under an env-resolved agent id",
    current: roster({ main: { ...main, agentDir: "/srv/main" } }),
    before: listRoster([{ id: "main", ...main, agentDir: "/srv/main" }]),
    authored: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${MAIN_AGENT_DIR}" }]),
    next: roster({ main: { ...main, agentDir: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "agentDir"]],
      explicitSetValueSource: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "/srv/main" }]),
    },
    expected: roster({ main: { ...main, agentDir: "/srv/main" } }),
  },
  {
    name: "preserves authored refs in a full legacy-list write with an env-backed id",
    current: roster({ main: { ...main, agentDir: "/resolved/old" } }),
    before: listRoster([{ id: "main", ...main, agentDir: "/resolved/old" }]),
    authored: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${OLD_DIR}" }]),
    next: roster({ main: { ...main, agentDir: "/resolved/new" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([{ id: "${AGENT_ID}", ...main, agentDir: "${NEW_DIR}" }]),
    },
    expected: roster({ main: { ...main, agentDir: "${NEW_DIR}" } }),
  },
  {
    name: "rejects a whole-list write with an unmappable new env-backed id",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ id: "main", ...main }]),
    next: roster({ main, worker: { workspace: "/resolved/worker" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "main", ...main },
        { id: "${WORKER_ID}", workspace: "${WORKER_DIR}" },
      ]),
    },
    error: "cannot safely resolve an explicitly replaced agent list slot",
  },
  {
    name: "preserves an entry-internal include authored in a legacy list while adding an agent",
    current: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } } }),
    before: listRoster([{ id: "main", ...main, identity: { name: "Main", emoji: "🦞" } }]),
    authored: listRoster([{ id: "main", ...main, identity: { $include: "./identity.json" } }]),
    next: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } }, worker }),
    expected: roster({ main: { ...main, identity: { $include: "./identity.json" } }, worker }),
  },
  {
    name: "rejects a roster write that changes an entry-internal included subtree",
    current: roster({ main: { ...main, identity: { name: "Main", emoji: "🦞" } } }),
    authored: roster({ main: { ...main, identity: { $include: "./identity.json" } } }),
    next: roster({ main: { ...main, identity: { name: "Changed", emoji: "🦞" } }, worker }),
    error: "flatten $include-owned config at agents.entries.main.identity",
  },
  {
    name: "preserves authored references when an agent id is renamed",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    before: listRoster([{ id: "main", ...authoredSecretEntry }]),
    authored: listRoster([{ id: "main", ...authoredSecretEntry }]),
    next: roster({ primary: runtimeSecretEntry }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "primary", ...runtimeSecretEntry }]),
      allowedAgentRosterRemovals: ["main"],
    },
    expected: roster({ primary: authoredSecretEntry }),
  },
  {
    name: "rejects an env-backed agent rename whose resolved identity is unavailable",
    current: roster({ main }),
    before: listRoster([{ id: "main", ...main }]),
    authored: listRoster([{ id: "${OLD_AGENT_ID}", ...main }]),
    next: roster({ ops: main }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "${NEW_AGENT_ID}", ...main }]),
    },
    error: "cannot safely resolve an env-backed renamed agent id",
  },
  {
    name: "applies a legacy-list unset to the renamed canonical entry",
    current: roster({ main: { ...main, workspace: "/srv/main" } }),
    before: listRoster([{ id: "main", ...main, workspace: "/srv/main" }]),
    authored: listRoster([{ id: "main", ...main, workspace: "/srv/main" }]),
    next: roster({ primary: main }),
    options: {
      explicitSetPaths: [["agents", "list", "0", "id"]],
      explicitSetValueSource: listRoster([{ id: "primary", ...main }]),
      unsetPaths: [["agents", "list", "0", "workspace"]],
      allowedAgentRosterRemovals: ["main"],
    },
    expected: roster({ primary: main }),
  },
  {
    name: "applies an indexed unset after an explicit legacy-list reorder with a resolved id",
    current: roster({ main: { ...main, workspace: "/srv/main" }, worker }),
    source: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "worker", ...worker },
    ]),
    before: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "worker", ...worker },
    ]),
    authored: listRoster([
      { id: "main", ...main, workspace: "/srv/main" },
      { id: "${WORKER_ID}", ...worker },
    ]),
    next: roster({ worker: {}, main: { ...main, workspace: "/srv/main" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "${WORKER_ID}" },
        { id: "main", ...main, workspace: "/srv/main" },
      ]),
      unsetPaths: [["agents", "list", "0", "workspace"]],
    },
    expected: roster({ worker: {}, main: { ...main, workspace: "/srv/main" } }),
  },
  {
    name: "removes the explicitly reordered list slot instead of the surviving agent",
    current: roster({ main, "0": worker }),
    source: listRoster([
      { id: "main", ...main },
      { id: "0", ...worker },
    ]),
    authored: listRoster([
      { id: "main", ...main },
      { id: "0", ...worker },
    ]),
    next: roster({ main }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "0", ...worker },
        { id: "main", ...main },
      ]),
      unsetPaths: [["agents", "list", "0"]],
      allowedAgentRosterRemovals: ["0"],
    },
    expected: roster({ main }),
  },
  {
    name: "rejects an indexed unset across duplicate explicit list ids",
    current: roster({ worker: { workspace: "/old" } }),
    source: listRoster([{ id: "worker", workspace: "/old" }]),
    before: listRoster([{ id: "worker", workspace: "/old" }]),
    authored: listRoster([{ id: "${WORKER_ID}", workspace: "/old" }]),
    next: roster({ worker: { workspace: "/second" } }),
    options: {
      explicitSetPaths: [["agents", "list"]],
      explicitSetValueSource: listRoster([
        { id: "${WORKER_ID}", workspace: "/first" },
        { id: "worker", workspace: "/second" },
      ]),
      unsetPaths: [["agents", "list", "0"]],
    },
    error: 'cannot canonicalize duplicate normalized agent id "worker"',
  },
  {
    name: "rejects ambiguous one-for-one replacements with authored references",
    current: roster({ main: runtimeSecretEntry }),
    source: roster({ main: authoredSecretEntry }),
    authored: roster({ main: authoredSecretEntry }),
    next: roster({ worker: { ...main, ...worker } }),
    error: "cannot safely match renamed agent entries",
  },
  {
    name: "preserves each duplicate legacy occurrence through compound migrations",
    current: listRoster([
      { id: "Research", workspace: "/srv/shared", memorySearch: { enabled: false } },
      { id: "Research", workspace: "/srv/shared", memorySearch: { enabled: false } },
    ]),
    authored: listRoster([
      { id: "Research", workspace: "${FIRST_WORKSPACE}", memorySearch: { enabled: false } },
      { id: "Research", workspace: "${SECOND_WORKSPACE}", memorySearch: { enabled: false } },
    ]),
    next: roster({
      research: { workspace: "/srv/shared", memory: { search: { enabled: false } } },
      "research-2": { workspace: "/srv/shared", memory: { search: { enabled: false } } },
    }),
    expected: roster({
      research: { workspace: "${FIRST_WORKSPACE}", memory: { search: { enabled: false } } },
      "research-2": { workspace: "${SECOND_WORKSPACE}", memory: { search: { enabled: false } } },
    }),
  },
  {
    name: "keeps the normalized default when authored legacy input marked it false",
    current: roster({ main, ops: { workspace: "/srv/ops" } }),
    before: listRoster([
      { id: "main", default: false },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    authored: listRoster([
      { id: "main", default: false },
      { id: "ops", workspace: "/srv/ops" },
    ]),
    next: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
    expected: roster({ main, ops: { workspace: "/srv/ops" }, worker }),
  },
  {
    name: "preserves authored references when roster arrays shift",
    current: roster({ main: { ...main, tools: { allow: ["read", "old"] } } }),
    authored: roster({ main: { ...main, tools: { allow: ["${PRIMARY_TOOL}", "old"] } } }),
    next: roster({ main: { ...main, tools: { allow: ["new", "read", "old"] } } }),
    expected: roster({ main: { ...main, tools: { allow: ["new", "${PRIMARY_TOOL}", "old"] } } }),
  },
  {
    name: "does not reuse an authored array reference after its source element was consumed",
    current: roster({ main: { ...main, tools: { allow: ["a", "b"] } } }),
    authored: roster({ main: { ...main, tools: { allow: ["${TOOL_A}", "${TOOL_B}"] } } }),
    next: roster({ main: { ...main, tools: { allow: ["b", "b"] } } }),
    expected: roster({ main: { ...main, tools: { allow: ["${TOOL_B}", "b"] } } }),
  },
  {
    name: "rejects unsetting an id inside a legacy list entry",
    current: roster({ main }),
    authored: listRoster([{ id: "main", ...main }]),
    next: roster({ main }),
    options: { unsetPaths: [["agents", "list", "0", "id"]] },
    error: "cannot unset an agent id",
  },
  {
    name: "does not resurrect an authored roster removed from the complete next config",
    current: { agents: { defaults: { workspace: "/srv/default" }, entries: { main } } },
    next: { agents: { defaults: { workspace: "/srv/default" } } },
    expected: { agents: { defaults: { workspace: "/srv/default" } } },
  },
  {
    name: "allows roster writes beside unrelated root includes using pre-migration provenance",
    current: roster({ main }),
    before: { channels: { telegram: { enabled: true } } },
    authored: { $include: "./channels.json" },
    next: roster({ main, worker }),
    expected: { $include: "./channels.json", ...roster({ main, worker }) },
  },
  {
    name: "preserves multiple keyed entry includes while adding one root-owned agent",
    current: explicitRoster({ tony, ops: { workspace: "/w/ops" } }),
    authored: explicitRoster({ tony: tonyInclude, ops: { $include: "./ops.json5" } }),
    next: explicitRoster({
      tony,
      ops: { workspace: "/w/ops" },
      worker: { workspace: "/w/worker" },
    }),
    options: { keyedAgentEntryIncludePaths: [...keyedTonyInclude, ["agents", "entries", "ops"]] },
    expected: explicitRoster({
      tony: tonyInclude,
      ops: { $include: "./ops.json5" },
      worker: { workspace: "/w/worker" },
    }),
  },
  {
    name: "rejects array-shaped entries containing an include",
    current: explicitRoster({ tony }),
    authored: explicitRoster([tonyInclude]),
    next: explicitRoster({ tony, worker: { workspace: "/w/worker" } }),
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "rejects an agents.entries include while adding a root-owned agent",
    current: explicitRoster({ tony }),
    authored: explicitRoster({ $include: "./agents.json5" }),
    next: explicitRoster({ tony, worker: { workspace: "/w/worker" } }),
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "rejects deleting a keyed entry include while adding a root-owned agent",
    current: explicitRoster({ tony }),
    authored: explicitRoster({ tony: tonyInclude }),
    next: explicitRoster({ worker: { workspace: "/w/worker" } }),
    options: {
      allowedAgentRosterRemovals: ["tony"],
      keyedAgentEntryIncludePaths: keyedTonyInclude,
    },
    error: "Config write would flatten $include-owned config at agents.entries.tony",
  },
  {
    name: "allows nested root-authored sibling edits without flattening included values",
    current: { gateway: { mode: "local", auth: { mode: "token", token: "old" } } },
    authored: { gateway: { $include: "./config/gateway.json", auth: { token: "old" } } },
    next: { gateway: { mode: "local", auth: { mode: "none", token: "new", strategy: "strict" } } },
    expected: {
      gateway: {
        $include: "./config/gateway.json",
        auth: { token: "new", mode: "none", strategy: "strict" },
      },
    },
  },
  {
    name: "does not copy runtime-normalized include values into root-authored siblings",
    current: { gateway: { tls: { certPath: "/home/test/cert.pem", enabled: false } } },
    source: { gateway: { tls: { certPath: "~/cert.pem", enabled: false } } },
    authored: { gateway: { $include: "./config/gateway.json", tls: { enabled: false } } },
    next: { gateway: { tls: { certPath: "~/cert.pem", enabled: true } } },
    expected: { gateway: { $include: "./config/gateway.json", tls: { enabled: true } } },
  },
  {
    name: "rejects included-value edits beside root-authored sibling edits",
    current: { gateway: { mode: "local", legacyKey: "old" } },
    authored: { gateway: { $include: "./config/gateway.json", legacyKey: "old" } },
    next: { gateway: { mode: "remote", legacyKey: "new" } },
    error: "Config write would flatten $include-owned config at gateway",
  },
  ...[
    { fallbacks: ["fixture/replacement"], envRef: false },
    { fallbacks: [], envRef: true },
  ].map(({ fallbacks, envRef }) => {
    const model = { primary: "fixture/primary", fallbacks: ["fixture/root"] };
    const source = withDefaults({ model });
    const authored = {
      agents: {
        $include: "./agents.json",
        defaults: { model: { fallbacks: [envRef ? "${FALLBACK}" : "fixture/root"] } },
      },
    };
    return {
      name: `allows root-array replacement ${JSON.stringify(fallbacks)} (env ref: ${envRef})`,
      current: withDefaults({ model, maxConcurrent: 16 }),
      source,
      before: envRef ? source : undefined,
      authored,
      next: withDefaults({ model: { ...model, fallbacks }, maxConcurrent: 16 }),
      expected: { agents: { $include: "./agents.json", defaults: { model: { fallbacks } } } },
    };
  }),
  {
    name: "rejects edits to arrays composed from both root and included values",
    current: {
      agents: { defaults: { model: { fallbacks: ["fixture/included", "fixture/root"] } } },
    },
    authored: {
      agents: {
        $include: "./agents.json",
        defaults: { model: { fallbacks: ["fixture/root"] } },
      },
    },
    next: { agents: { defaults: { model: { fallbacks: ["fixture/root"] } } } },
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "does not infer array ownership from a normalized baseline that dropped included values",
    before: {
      agents: { defaults: { model: { fallbacks: ["fixture/included", "fixture/root"] } } },
    },
    current: { agents: { defaults: { model: { fallbacks: ["fixture/root"] } } } },
    authored: {
      agents: { $include: "./agents.json", defaults: { model: { fallbacks: ["fixture/root"] } } },
    },
    next: { agents: { defaults: { model: { fallbacks: [] } } } },
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "rejects replacing root arrays that contain nested includes",
    before: { agents: { defaults: { model: { fallbacks: ["fixture/root"] } } } },
    current: { agents: { defaults: { model: { fallbacks: ["fixture/root"] } } } },
    authored: {
      agents: {
        $include: "./agents.json",
        defaults: { model: { fallbacks: [{ $include: "./fallback.json" }] } },
      },
    },
    next: { agents: { defaults: { model: { fallbacks: [] } } } },
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "preserves include-owned array entries across runtime-only normalization",
    current: {
      ...listRoster([{ id: "main", workspace: "/home/test/agent" }]),
      gateway: { mode: "local" },
    },
    source: { ...listRoster([{ id: "main", workspace: "~/agent" }]), gateway: { mode: "local" } },
    authored: {
      ...listRoster([{ $include: "./config/main-agent.json" }]),
      gateway: { mode: "local" },
    },
    next: {
      ...listRoster([{ id: "main", workspace: "~/agent" }]),
      gateway: { mode: "local", port: 18789 },
    },
    expected: {
      ...listRoster([{ $include: "./config/main-agent.json" }]),
      gateway: { mode: "local", port: 18789 },
    },
  },
  {
    name: "rejects roster edits beside an include-owned array entry",
    current: listRoster([
      { id: "main", workspace: "~/agent" },
      { id: "ops", workspace: "~/ops" },
    ]),
    authored: listRoster([
      { $include: "./config/main-agent.json" },
      { id: "ops", workspace: "~/ops" },
    ]),
    next: listRoster([
      { id: "main", workspace: "~/agent" },
      { id: "ops", workspace: "~/ops-next" },
      { id: "new", workspace: "~/new" },
    ]),
    error: "Config write would flatten $include-owned config at agents",
  },
  {
    name: "allows unrelated removals after duplicate include-resolved values",
    current: { plugins: { load: { paths: ["/same", "/same", "/other"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/other"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/same"] } } },
    expected: { plugins: { load: { paths: [{ $include: "./path.json5" }, "/same"] } } },
  },
  {
    name: "rejects included-entry removals hidden by duplicate sibling edits",
    current: { plugins: { load: { paths: ["/same", "/same", "/old"] } } },
    authored: {
      plugins: { load: { paths: [{ $include: "./path.json5" }, "/same", "/old"] } },
    },
    next: { plugins: { load: { paths: ["/same", "/new"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.0",
  },
  {
    name: "rejects newly introduced duplicates of include-owned array entries",
    current: { plugins: { load: { paths: ["/root", "/included"] } } },
    authored: { plugins: { load: { paths: ["/root", { $include: "./path.json5" }] } } },
    next: { plugins: { load: { paths: ["/included", "/included"] } } },
    error: "Config write would flatten $include-owned config at plugins.load.paths.1",
  },
  {
    name: "preserves authored agent provider params during narrowed agent-list writes",
    current: {
      agents: { defaults: { ...providerDefaults, maxConcurrent: 4 }, list: [{ id: "main" }] },
      gateway: { mode: "local" },
    },
    source: {
      agents: { defaults: providerDefaults, list: [{ id: "main" }] },
      gateway: { mode: "local" },
    },
    next: { agents: { list: [{ id: "main" }, { id: "ops" }] }, gateway: { mode: "local" } },
    expected: {
      agents: { defaults: providerDefaults, entries: { main: {}, ops: {} } },
      gateway: { mode: "local" },
    },
  },
  ...(
    [
      [retiredModel, canonicalModel],
      ["custom/custom/model", "custom/custom/model"],
    ] as const
  ).map(([authored, canonical]): WriteCase => {
    const params = { thinking: { level: "high" } };
    return {
      name: `preserves separate authored model params when writing ${authored}`,
      source: selectedModel(authored, { [authored]: { alias: "Selected", params } }),
      current: selectedModel(canonical, { [canonical]: { alias: "Selected", params } }),
      next: selectedModel(canonical, { [canonical]: {} }),
      expected: selectedModel(authored, { [canonical]: { params } }),
    };
  }),
  {
    name: "canonicalizes only agent model maps touched through normalized runtime identities",
    source: scopedModelMaps(retiredModel, "before"),
    current: scopedModelMaps(canonicalModel, "before"),
    next: scopedModelMaps(canonicalModel, "after"),
    expected: scopedModelMaps(canonicalModel, "after"),
  },
  {
    name: "canonicalizes an explicitly persisted model-map path even when runtime values are equal",
    source: withModels({ [retiredModel]: geminiEntry }),
    current: withModels({ [canonicalModel]: geminiEntry }),
    next: withModels({ [canonicalModel]: geminiEntry }),
    options: { explicitSetPaths: [["agents", "defaults", "models"]] },
    expected: withModels({ [canonicalModel]: geminiEntry }),
  },
  {
    name: "preserves untouched model rows that share a runtime identity",
    source: sharedModelSource,
    current: sharedModelRuntime,
    next: { ...sharedModelRuntime, gateway: { port: 18888 } },
    expected: { ...sharedModelSource, gateway: { port: 18888 } },
  },
  {
    name: "does not reintroduce legacy openai-codex model params after doctor route repair",
    current: legacyRoute,
    next: repairedRoute,
    expected: repairedRoute,
  },
  {
    name: "allows explicit unsets to remove authored agent provider params",
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
    expected: withModels({ "openai/gpt-5.4": {} }),
  },
];

function resolveWriteCase(testCase: WriteCase): unknown {
  return resolvePersistCandidateForWrite({
    runtimeConfig: testCase.current,
    sourceConfig: testCase.source ?? testCase.current,
    nextConfig: testCase.next,
    ...(testCase.authored === undefined ? {} : { rootAuthoredConfig: testCase.authored }),
    ...(testCase.before === undefined ? {} : { sourceConfigBeforeMigrations: testCase.before }),
    ...testCase.options,
  });
}

describe("config io write prepare", () => {
  for (const testCase of writeCases) {
    it(testCase.name, () => {
      if (testCase.error) {
        expect(() => resolveWriteCase(testCase)).toThrow(testCase.error);
        return;
      }
      const expected = structuredClone(testCase.expected);
      expect(resolveWriteCase(testCase)).toEqual(expected);
    });
  }

  it.each([
    { includeAt: "root", authoredDefaults: true },
    { includeAt: "agents", authoredDefaults: false },
  ])(
    "preserves explicit sibling intent beside a $includeAt include (authored defaults: $authoredDefaults)",
    ({ includeAt, authoredDefaults }) => {
      const authoredAgents = {
        ownership: "explicit",
        ...(authoredDefaults ? { defaults: { workspace: "/old" } } : {}),
        entries: { main: {}, spare: {} },
      };
      const rootAuthoredConfig =
        includeAt === "root"
          ? { $include: "./base.json", agents: authoredAgents }
          : { agents: { $include: "./base.json", ...authoredAgents } };
      const sourceConfig = {
        agents: {
          ...authoredAgents,
          defaults: { ...authoredAgents.defaults, model: { primary: "fixture/primary" } },
        },
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
        resolvePersistCandidateForWrite({
          sourceConfig,
          rootAuthoredConfig,
          runtimeConfig,
          nextConfig: { ...runtimeConfig, agents: { ...runtimeConfig.agents, entries } },
          explicitSetPaths: [
            ["agents", "entries"],
            ["agents", "defaults", "maxConcurrent"],
            ["commands", "restart"],
          ],
          allowIncludeAncestorExplicitSetPaths: true,
        }),
      ).toEqual({
        ...rootAuthoredConfig,
        commands: { restart: true },
        agents: {
          ...rootAuthoredConfig.agents,
          entries,
          defaults: { ...authoredAgents.defaults, maxConcurrent: 16 },
        },
      });
    },
  );

  it.each(
    [
      {
        name: "included",
        authored: undefined,
        resolved: ["included"],
        allowed: false,
        kinds: ["parent", "index"],
      },
      {
        name: "mixed",
        authored: ["root"],
        resolved: ["included", "root"],
        allowed: false,
        kinds: ["parent"],
      },
      {
        name: "root-owned",
        authored: ["root"],
        resolved: ["root"],
        allowed: true,
        kinds: ["index"],
      },
      { name: "empty include", authored: undefined, resolved: [], allowed: true, kinds: ["array"] },
    ].flatMap((testCase) => testCase.kinds.map((kind) => ({ testCase, kind }))),
  )("checks $testCase.name array ownership for explicit $kind writes", ({ testCase, kind }) => {
    const sourceConfig = {
      agents: { defaults: { model: { fallbacks: testCase.resolved } }, entries: { main: {} } },
    };
    const rootAuthoredConfig = {
      agents: {
        $include: "./agents.json",
        entries: { main: {} },
        ...(testCase.authored ? { defaults: { model: { fallbacks: testCase.authored } } } : {}),
      },
    };
    const write = () =>
      resolvePersistCandidateForWrite({
        sourceConfig,
        sourceConfigBeforeMigrations: sourceConfig,
        runtimeConfig: sourceConfig,
        rootAuthoredConfig,
        nextConfig: { agents: { ...sourceConfig.agents, entries: { main: {}, worker: {} } } },
        explicitSetPaths: [
          ["agents", "entries"],
          kind === "parent"
            ? ["agents", "defaults"]
            : [
                "agents",
                "defaults",
                "model",
                "fallbacks",
                ...(kind === "index" ? [String(testCase.resolved.length - 1)] : []),
              ],
        ],
        allowIncludeAncestorExplicitSetPaths: true,
      });
    const persisted = write();
    expect(persisted).toMatchObject({
      agents: {
        $include: "./agents.json",
        entries: { main: {}, worker: {} },
      },
    });
    const authored = testCase.allowed ? testCase.resolved : testCase.authored;
    if (authored === undefined) {
      expect(persisted).not.toHaveProperty("agents.defaults.model.fallbacks");
    } else {
      expect(persisted).toHaveProperty("agents.defaults.model.fallbacks", authored);
    }
  });

  it("uses recorded facts instead of placeholder-shaped roster bytes", () => {
    const literalId = "${AGENT_ID}";
    const sourceConfigBeforeMigrations = listRoster([{ id: literalId, ...main }]);
    const resolveRename = () =>
      resolvePersistCandidateForWrite({
        runtimeConfig: roster({ [literalId]: main }),
        sourceConfig: roster({ [literalId]: main }),
        sourceConfigBeforeMigrations,
        rootAuthoredConfig: listRoster([{ id: literalId, ...main }]),
        nextConfig: roster({ renamed: main }),
        explicitSetPaths: [["agents", "list", "0", "id"]],
        explicitSetValueSource: listRoster([{ id: "renamed", ...main }]),
        allowedAgentRosterRemovals: [literalId],
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

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: migrated,
      sourceConfig: migrated,
      sourceConfigBeforeMigrations: authored,
      rootAuthoredConfig: authored,
      nextConfig: { gateway: { port: 19001 } },
      preserveLegacyAgentRoster: true,
      explicitSetPaths: [["gateway", "port"]],
      explicitSetValueSource: { gateway: { port: 19001 } },
    });

    expect(persisted).toHaveProperty("agents.entries.research.default", true);
    const reloaded = createCanonicalAgentConfigFixture(persisted).config;
    expect(tryResolveLegacyCompatibilityAgentId(reloaded)).toBe("research");
  });

  it("rejects duplicate normalized ids before canonicalizing a legacy roster", () => {
    const nextConfig = listRoster([
      { id: "Ops", workspace: "/first" },
      { id: " ops ", workspace: "/second" },
    ]);
    const before = structuredClone(nextConfig);
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: {},
        sourceConfig: {},
        nextConfig,
        explicitSetPaths: [["agents", "list"]],
        explicitSetValueSource: nextConfig,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "DuplicateAgentRosterIdError",
        message: 'Config write cannot canonicalize duplicate normalized agent id "ops".',
      }),
    );
    expect(nextConfig).toEqual(before);
  });

  it("omits canonical entries when the complete legacy list is unset", () => {
    const unsetPaths = [["agents", "list"]];
    const persisted = applyUnsetPathsForWrite(
      resolvePersistCandidateForWrite({
        runtimeConfig: roster({ main }),
        sourceConfig: roster({ main }),
        rootAuthoredConfig: listRoster([{ id: "main", ...main }]),
        nextConfig: roster({ main }),
        unsetPaths,
        allowedAgentRosterRemovals: ["main"],
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

  it.each([
    {
      name: "allows an explicit local leaf override beside a root include",
      authored: { $include: "./agents.json5" },
      expected: {
        $include: "./agents.json5",
        agents: { defaults: { workspace: "/srv/next" } },
      },
    },
    {
      name: "allows an explicit local leaf override below a nested include",
      authored: { agents: { $include: "./agents.json5" } },
      expected: {
        agents: { $include: "./agents.json5", defaults: { workspace: "/srv/next" } },
      },
    },
  ])("$name", ({ authored, expected }) => {
    const sourceConfig = {
      agents: { defaults: { workspace: "/srv/old" }, entries: { ops: main } },
    };
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig: sourceConfig,
        sourceConfig,
        rootAuthoredConfig: authored,
        nextConfig: sourceConfig,
        explicitSetPaths: [["agents", "defaults", "workspace"]],
        explicitSetValueSource: { agents: { defaults: { workspace: "/srv/next" } } },
        allowIncludeAncestorExplicitSetPaths: true,
      }),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "persists explicitly set array-index children whose values match runtime defaults",
      paths: [["models", "providers", "openai", "models", "0", "contextWindow"]],
      includesDefault: true,
    },
    {
      name: "ignores unsafe array-index explicit set paths",
      paths: [
        ["models", "providers", "openai", "models", "0abc", "contextWindow"],
        ["models", "providers", "openai", "models", "+0", "contextWindow"],
        ["models", "providers", "openai", "models", "9007199254740993", "contextWindow"],
        ["models", "providers", "openai", "models", "4294967294", "contextWindow"],
      ],
      includesDefault: false,
    },
  ])("$name", ({ paths, includesDefault }) => {
    const withProviderModels = (models: Record<string, unknown>[]) => ({
      models: { providers: { openai: { models } } },
    });
    const sourceConfig = withProviderModels([{ id: "gpt-5.5" }]);
    const runtimeConfig = withProviderModels([{ id: "gpt-5.5", contextWindow: 128000 }]);
    expect(
      resolvePersistCandidateForWrite({
        runtimeConfig,
        sourceConfig,
        nextConfig: sourceConfig,
        explicitSetValueSource: runtimeConfig,
        explicitSetPaths: paths,
      }),
    ).toEqual(includesDefault ? runtimeConfig : sourceConfig);
  });

  it("rejects default-valued explicit writes under include-owned paths", () => {
    const sourceConfig = { agents: { defaults: {} } };
    expect(() =>
      resolvePersistCandidateForWrite({
        runtimeConfig: { agents: { defaults: { params: { temperature: 0 } } } },
        sourceConfig,
        rootAuthoredConfig: { agents: { defaults: { $include: "./agents-defaults.json" } } },
        nextConfig: sourceConfig,
        explicitSetValueSource: { agents: { defaults: { params: { temperature: 0 } } } },
        explicitSetPaths: [["agents", "defaults", "params"]],
      }),
    ).toThrow("Config write would flatten $include-owned config at agents.defaults");
  });
});
