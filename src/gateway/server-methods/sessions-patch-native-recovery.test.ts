import { beforeEach, expect, it, vi } from "vitest";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { prepareModelSelectionRuntime } from "../../auto-reply/reply/model-runtime-normalization.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionPatchRuntimeSelection } from "./sessions-patch-model-selection.js";

const preparation = vi.hoisted(() => {
  const validate = vi.fn((): string | undefined => undefined);
  return {
    validate,
    prepare: vi.fn<typeof prepareModelSelectionRuntime>(async () => ({
      status: "ready" as const,
      runtime: { kind: "set" as const, runtime: "native-fixture" },
      catalog: [],
      harness: {
        id: "native-fixture",
        label: "Native fixture",
        executionEnvironment: "host-only" as const,
        supports: () => ({ supported: true as const }),
        runAttempt: vi.fn(),
      },
      validateRuntimeSelection: validate,
    })),
  };
});
vi.mock("../../auto-reply/reply/model-runtime-normalization.js", () => ({
  prepareModelSelectionRuntime: preparation.prepare,
}));
vi.mock("./sessions-shared.js", () => ({
  resolveSessionWorkerPlacementPatchError: () => undefined,
}));

beforeEach(() => {
  preparation.validate.mockReset();
  preparation.prepare.mockReset();
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
function prepare(entry: SessionEntry, callerCanConsent = true, config = cfg) {
  return prepareSessionPatchRuntimeSelection({
    cfg: config,
    agentId: "main",
    patch: { key, model },
    entry,
    expectedEntry: original,
    callerCanConsent,
  });
}

it.each([
  { reason: "sandbox", tools: undefined },
  { reason: "workspace-only", tools: { fs: { workspaceOnly: true } } },
  { reason: "tool-policy", tools: { deny: ["exec"] } },
])("offers chat-bound recovery for optional $reason", async ({ tools, reason }) => {
  const entry: SessionEntry = {
    ...original,
    ...(tools
      ? { agentRuntimeOverride: "native-fixture", permissionMode: "full", sandboxMode: "off" }
      : {}),
  };
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
    expect(
      (await prepare({ ...entry, nativeRuntimeConsent: "native-fixture" }, true, config)).ok,
    ).toBe(true);
    expect(
      (await prepare({ ...entry, nativeRuntimeConsent: "different-runtime" }, true, config)).ok,
    ).toBe(false);
  }
});

it.each([
  { label: "non-admin", entry: original, admin: false, config: cfg, reason: "sandbox" },
  {
    label: "mandatory sandbox",
    entry: { ...original, sandbox: "required" as const, sandboxMode: "off" as const },
    admin: true,
    config: cfg,
    reason: "sandbox-required",
  },
  {
    label: "globally configured node",
    entry: original,
    admin: true,
    config: { ...cfg, tools: { exec: { host: "node" as const } } },
    reason: "remote-execution",
  },
  {
    label: "agent-configured node",
    entry: original,
    admin: true,
    config: {
      ...cfg,
      agents: { ...cfg.agents, entries: { main: { tools: { exec: { host: "node" as const } } } } },
    },
    reason: "remote-execution",
  },
])("does not offer an escape from $label", async ({ entry, admin, config, reason }) => {
  const result = await prepare({ ...entry }, admin, config);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected native refusal");
  }
  expect(result.error.details).toMatchObject({ code: "AGENT_RUNTIME_RESTRICTED", reason });
  expect(result.error.details).not.toHaveProperty("recovery");
});

it.each([
  { label: "the same model and auth profile", patch: {}, entry: {}, preserved: true },
  {
    label: "a different model",
    patch: { model: "fixture/other@fixture:selected" },
    entry: { modelOverride: "other" },
    preserved: false,
  },
  {
    label: "a different auth profile",
    patch: { model: `${model}@fixture:other` },
    entry: { authProfileOverride: "fixture:other" },
    preserved: false,
  },
  {
    label: "an explicit runtime",
    patch: { agentRuntime: "native-fixture" },
    entry: {},
    preserved: false,
  },
  {
    label: "a cleared runtime",
    patch: { agentRuntime: null },
    entry: { agentRuntimeOverride: undefined },
    preserved: false,
  },
  {
    label: "a native consent grant",
    patch: { nativeRuntimeConsent: "native-fixture" },
    entry: {},
    preserved: false,
  },
] satisfies {
  label: string;
  patch: Partial<SessionsPatchParams>;
  entry: Partial<SessionEntry>;
  preserved: boolean;
}[])("handles $label when runtime preparation is unavailable", async (testCase) => {
  const message = "A runtime is not available. Refresh the model catalog and choose again.";
  preparation.prepare.mockResolvedValue({ status: "rejected", reason: "invalid-runtime", message });
  const expectedEntry: SessionEntry = {
    ...original,
    permissionMode: "full",
    sandboxMode: "off",
    authProfileOverride: "fixture:selected",
    agentRuntimeOverride: "native-fixture",
  };
  const entry: SessionEntry = { ...expectedEntry, ...testCase.entry };
  const result = await prepareSessionPatchRuntimeSelection({
    cfg,
    agentId: "main",
    patch: { key, model: `${model}@fixture:selected`, ...testCase.patch },
    entry,
    expectedEntry,
    callerCanConsent: true,
  });

  if (testCase.preserved) {
    expect(result.ok).toBe(true);
    expect(entry.agentRuntimeOverride).toBe("native-fixture");
    if (!result.ok) {
      throw new Error("Expected the existing selection to be preserved");
    }
    expect(result.validate?.()).toBeUndefined();
  } else {
    expect(result).toMatchObject({ ok: false, error: { message } });
  }
});

it.each([false, true])(
  "accepts an unrestricted local candidate (dormant node=%s)",
  async (node) => {
    const result = await prepare(
      {
        ...original,
        sandboxMode: "off",
        permissionMode: "full",
        ...(node ? { execHost: "gateway", execNode: "dormant-node" } : {}),
      },
      true,
      node ? { tools: { exec: { host: "node" } } } : cfg,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected recovery selection");
    }
    expect(result.validate?.()).toBeUndefined();
    preparation.validate.mockReturnValue("Runtime owner changed");
    expect(result.validate?.()).toMatchObject({ message: "Runtime owner changed" });
    expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
  },
);

it.each([false, true])(
  "defers optional creation restrictions but preserves mandatory sandbox=%s",
  async (mandatory) => {
    const entry: SessionEntry = {
      ...original,
      ...(mandatory ? { sandbox: "required" as const } : {}),
    };
    const result = await prepareSessionPatchRuntimeSelection({
      cfg,
      agentId: "main",
      patch: { key, model },
      entry,
    });
    expect(result.ok).toBe(!mandatory);
    expect(entry.nativeRuntimeConsent).toBeUndefined();
    if (!result.ok) {
      expect(result.error.details).toMatchObject({ reason: "sandbox-required" });
      expect(result.error.details).not.toHaveProperty("recovery");
    }
  },
);
