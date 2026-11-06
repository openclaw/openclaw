import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import * as harnessRegistry from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import * as modelRuntime from "../../auto-reply/reply/model-runtime-normalization.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionCreateRuntimeSelection } from "../session-create-model-selection.js";
import { prepareSessionPatchRuntimeSelection as prepareRuntimeSelection } from "./sessions-patch-model-selection.js";

const releaseSelections: Array<() => void> = [];
afterEach(() => {
  releaseSelections.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
});
const validate = vi.fn((): string | undefined => undefined);
let prepareRuntime: MockInstance<typeof modelRuntime.prepareModelSelectionRuntime>;
let harness: AgentHarness;
beforeEach(() => {
  validate.mockReset();
  harness = {
    id: "native-fixture",
    label: "Native fixture",
    executionEnvironment: "host-only",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  };
  prepareRuntime = vi.spyOn(modelRuntime, "prepareModelSelectionRuntime").mockResolvedValue({
    status: "ready",
    runtime: { kind: "set", runtime: "native-fixture" },
    catalog: [],
    harness,
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

const operatorAuthority = (accessOnly: boolean): AdmittedRunOperatorAuthority =>
  createAdmittedRunOperatorAuthority({
    profileId: "runtime-policy-fixture",
    scopes: ["operator.admin"],
    assertCurrent() {},
    ...(accessOnly
      ? {
          rolePolicy: {
            sessionAccessCap: "none" as const,
            sandboxRequired: false,
            agents: "*" as const,
          },
        }
      : { modelPolicy: { models: [], allows: () => true } }),
  });

it.each([false, true])(
  "rejects a runtime without exact role enforcement before applying it (Access-only=%s)",
  async (accessOnly) => {
    const entry = unrestricted({ agentRuntimeOverride: "openclaw" });
    const before = { ...entry };
    const result = await prepare(entry, true, cfg, {
      operatorAuthority: operatorAuthority(accessOnly),
      patch: { key, model, agentRuntime: "native-fixture" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("cannot enforce your operator role") },
    });
    expect(entry).toEqual(before);
  },
);

it("retains exact native runtimes and rechecks operator policy at commit", async () => {
  harness.nativeModelPolicySupport = "exact";
  expect(
    (await prepare(unrestricted(), true, cfg, { operatorAuthority: operatorAuthority(true) })).ok,
  ).toBe(true);

  harness.nativeModelPolicySupport = undefined;
  let policy: AdmittedRunOperatorAuthority["modelPolicy"] = undefined;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "runtime-policy-fixture",
    scopes: ["operator.admin"],
    assertCurrent() {},
    get modelPolicy() {
      return policy;
    },
  });
  const result = await prepare(unrestricted(), true, cfg, { operatorAuthority: authority });
  assert(result.ok);
  expect(result.validate?.()).toBeUndefined();
  policy = { models: [], allows: () => true };
  expect(result.validate?.()).toMatchObject({
    message: expect.stringContaining("cannot enforce your operator role"),
  });
});

it("checks role enforcement when preserving an unchanged explicit account and runtime", async () => {
  vi.spyOn(harnessRegistry, "getRegisteredAgentHarness").mockReturnValue({ harness });
  const entry = unrestricted({
    authProfileOverride: "fixture:selected",
    agentRuntimeOverride: "native-fixture",
  });
  const result = await prepare({ ...entry }, true, cfg, {
    operatorAuthority: operatorAuthority(true),
    expectedEntry: entry,
    patch: { key, model: `${model}@fixture:selected` },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("cannot enforce your operator role") },
  });
  expect(prepareRuntime).not.toHaveBeenCalled();
});

it.each(["model", "agentRuntime", "create"] as const)(
  "validates inherited role enforcement for %s without preparing a new catalog",
  async (selection) => {
    vi.spyOn(harnessRegistry, "getRegisteredAgentHarness").mockImplementation((id) =>
      id === harness.id ? { harness } : undefined,
    );
    for (const [runtime, restricted, exact, accepted] of [
      ["native-fixture", true, false, false],
      ["native-fixture", false, false, true],
      ["native-fixture", true, true, true],
      ["openclaw", true, false, true],
    ] as const) {
      harness.nativeModelPolicySupport = exact ? "exact" : undefined;
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            ...cfg.agents?.defaults,
            model,
            models: { [model]: { agentRuntime: { id: runtime } } },
          },
        },
      };
      const entry = unrestricted(
        selection === "agentRuntime"
          ? {}
          : { providerOverride: undefined, modelOverride: undefined },
      );
      const authority = restricted ? operatorAuthority(true) : undefined;
      const result =
        selection === "create"
          ? await prepareSessionCreateRuntimeSelection({
              request: { cfg: config },
              agentId: "main",
              operatorAuthority: authority,
              sessionKey: key,
              storePath: "unused-fixture-store",
              entry,
              existingEntry: { ...entry },
              catalog: undefined,
              validateModelSelection: undefined,
            })
          : await prepare(entry, true, config, {
              operatorAuthority: authority,
              expectedEntry: unrestricted(
                selection === "model"
                  ? { modelOverride: "previous" }
                  : { agentRuntimeOverride: "openclaw" },
              ),
              patch: { key, [selection]: null },
            });
      expect(result.ok).toBe(accepted);
      if (result.ok) {
        expect(result.validate?.()).toBeUndefined();
        if (exact) {
          const previousHarness = harness;
          harness = { ...harness, nativeModelPolicySupport: undefined };
          expect(result.validate?.()?.message).toContain("cannot enforce your operator role");
          harness = previousHarness;
        }
        if (selection === "create" && result.release) {
          releaseSelections.push(result.release);
        }
      } else {
        expect(result.error.message).toContain("cannot enforce your operator role");
      }
    }
    expect(prepareRuntime).not.toHaveBeenCalled();
  },
);

it("does not validate an inherited runtime for an unrelated metadata patch", async () => {
  const lookup = vi
    .spyOn(harnessRegistry, "getRegisteredAgentHarness")
    .mockReturnValue({ harness });
  expect(
    (
      await prepare(unrestricted(), true, cfg, {
        operatorAuthority: operatorAuthority(true),
        patch: { key, label: "renamed" },
      })
    ).ok,
  ).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  expect(prepareRuntime).not.toHaveBeenCalled();
});

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
