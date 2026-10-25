import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import * as modelRuntime from "../../auto-reply/reply/model-runtime-normalization.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionPatchRuntimeSelection as prepareRuntimeSelection } from "./sessions-patch-model-selection.js";

const releaseSelections: Array<() => void> = [];
afterEach(() => {
  releaseSelections.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
});
const validate = vi.fn((): string | undefined => undefined);
let prepareRuntime: MockInstance<typeof modelRuntime.prepareModelSelectionRuntime>;
beforeEach(() => {
  validate.mockReset();
  prepareRuntime = vi.spyOn(modelRuntime, "prepareModelSelectionRuntime").mockResolvedValue({
    status: "ready",
    runtime: { kind: "set", runtime: "native-fixture" },
    catalog: [],
    harness: {
      id: "native-fixture",
      label: "Native fixture",
      executionEnvironment: "host-only",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
    },
    validateRuntimeSelection: validate,
  });
});
const key = "agent:main:chat";
const model = "fixture/model";
const original: SessionEntry = {
  sessionId: "original-session",
  lifecycleRevision: "original-generation",
  updatedAt: 1,
  permissionMode: "workspace",
  providerOverride: "fixture",
  modelOverride: "model",
};
const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
const nodeTools = { exec: { host: "node" } } as const;
function agentConfig<T extends AgentEntryConfig>(entry: T) {
  return { ...cfg, agents: { ...cfg.agents, entries: { main: entry } } };
}
function unrestricted(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { ...original, permissionMode: "full", sandboxMode: "off", ...overrides };
}
async function prepare(
  entry: SessionEntry,
  callerCanConsent = true,
  config: OpenClawConfig = cfg,
  overrides: Partial<Parameters<typeof prepareRuntimeSelection>[0]> = {},
) {
  const result = await prepareRuntimeSelection({
    cfg: config,
    agentId: "main",
    patch: { key, model },
    entry,
    expectedEntry: original,
    callerCanConsent,
    ...overrides,
  });
  if (result.ok && result.release) {
    releaseSelections.push(result.release);
  }
  return result;
}

it.each([
  { reason: "sandbox", tools: undefined },
  { reason: "workspace-only", tools: { fs: { workspaceOnly: true } } },
  { reason: "tool-policy", tools: { deny: ["exec"] } },
])("offers chat-bound recovery for optional $reason", async ({ tools, reason }) => {
  const entry = tools ? unrestricted({ agentRuntimeOverride: "native-fixture" }) : { ...original };
  const config = tools ? { tools } : cfg;
  expect(await prepare(entry, true, config)).toMatchObject({
    ok: false,
    error: {
      details: {
        code: "AGENT_RUNTIME_RESTRICTED",
        reason,
        runtimeId: "native-fixture",
        recovery: {
          action: "use-native-permissions",
          sessionId: original.sessionId,
          lifecycleRevision: original.lifecycleRevision,
          expectedPermissionMode: "workspace",
          expectedSandboxMode: null,
          expectedNativeRuntimeConsent: null,
        },
      },
    },
  });
  if (tools) {
    for (const consent of ["native-fixture", "different-runtime"]) {
      expect((await prepare({ ...entry, nativeRuntimeConsent: consent }, true, config)).ok).toBe(
        consent === "native-fixture",
      );
    }
  }
});

it("applies remembered native permissions on selection without creating per-chat consent", async () => {
  const config = agentConfig({ nativeRuntimeConsent: ["native-fixture"] });
  const entry = { ...original };
  expect((await prepare(entry, true, config)).ok).toBe(true);
  expect(entry).toMatchObject({ permissionMode: "full", sandboxMode: "off" });
  expect(entry).not.toHaveProperty("nativeRuntimeConsent");
  expect((await prepare({ ...original, sandbox: "required" }, true, config)).ok).toBe(false);
  expect((await prepare({ ...original }, false, config)).ok).toBe(false);
  config.agents.entries.main.nativeRuntimeConsent = [];
  expect((await prepare({ ...original }, true, config)).ok).toBe(false);
});

it.each([
  ["non-admin", {}, false, cfg, "sandbox"],
  ["mandatory sandbox", { sandbox: "required", sandboxMode: "off" }, true, cfg, "sandbox-required"],
  ["global node", {}, true, { ...cfg, tools: nodeTools }, "remote-execution"],
  ["agent node", {}, true, agentConfig({ tools: nodeTools }), "remote-execution"],
] satisfies [string, Partial<SessionEntry>, boolean, OpenClawConfig, string][])(
  "does not offer an escape from %s",
  async (_label, overrides, admin, config, reason) => {
    const result = await prepare({ ...original, ...overrides }, admin, config);
    assert(!result.ok, "Expected native refusal");
    expect(result.error.details).toMatchObject({ code: "AGENT_RUNTIME_RESTRICTED", reason });
    expect(result.error.details).not.toHaveProperty("recovery");
  },
);

it.each([
  [{}, {}, true],
  [{ model: "fixture/other@fixture:selected" }, { modelOverride: "other" }, false],
  [{ model: `${model}@fixture:other` }, { authProfileOverride: "fixture:other" }, false],
  [{ agentRuntime: "native-fixture" }, {}, false],
  [{ agentRuntime: null }, { agentRuntimeOverride: undefined }, false],
  [{ nativeRuntimeConsent: "native-fixture" }, {}, false],
] satisfies [Partial<SessionsPatchParams>, Partial<SessionEntry>, boolean][])(
  "preserves only unchanged selections when preparation is unavailable (patch %j)",
  async (patch, overrides, preserved) => {
    const message = "A runtime is not available. Refresh the model catalog and choose again.";
    prepareRuntime.mockResolvedValue({
      status: "rejected",
      reason: "invalid-runtime",
      message,
    });
    const expectedEntry = unrestricted({
      authProfileOverride: "fixture:selected",
      agentRuntimeOverride: "native-fixture",
    });
    const entry: SessionEntry = { ...expectedEntry, ...overrides };
    const result = await prepare(entry, true, cfg, {
      patch: { key, model: `${model}@fixture:selected`, ...patch },
      expectedEntry,
    });
    if (preserved) {
      expect(entry.agentRuntimeOverride).toBe("native-fixture");
      assert(result.ok, "Expected the existing selection to be preserved");
      expect(result.validate?.()).toBeUndefined();
    } else {
      expect(result).toMatchObject({ ok: false, error: { message } });
    }
  },
);

it.each([false, true])("validates local selection (dormant node=%s)", async (node) => {
  const result = await prepare(
    unrestricted(node ? { execHost: "gateway", execNode: "dormant-node" } : {}),
    true,
    node ? { tools: { exec: { host: "node" } } } : cfg,
  );
  assert(result.ok, "Expected recovery selection");
  expect(result.validate?.()).toBeUndefined();
  validate.mockReturnValue("Runtime owner changed");
  expect(result.validate?.()).toMatchObject({ message: "Runtime owner changed" });
  expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
});

it.each([false, true])("preserves mandatory sandbox=%s at creation", async (mandatory) => {
  const entry = mandatory ? { ...original, sandbox: "required" as const } : { ...original };
  const result = await prepare(entry, false, cfg, { expectedEntry: undefined });
  expect(result.ok).toBe(!mandatory);
  expect(entry.nativeRuntimeConsent).toBeUndefined();
  if (!result.ok) {
    expect(result.error.details).toMatchObject({ reason: "sandbox-required" });
    expect(result.error.details).not.toHaveProperty("recovery");
  }
});
