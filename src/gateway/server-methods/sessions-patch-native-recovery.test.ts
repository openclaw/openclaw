import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionPatchRuntimeSelection } from "./sessions-patch-model-selection.js";

const preparation = vi.hoisted(() => ({ validate: vi.fn((): string | undefined => undefined) }));
vi.mock("../../auto-reply/reply/model-runtime-normalization.js", () => ({
  prepareModelSelectionRuntime: async () => ({
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
    validateRuntimeSelection: preparation.validate,
  }),
}));
vi.mock("./sessions-shared.js", () => ({
  resolveSessionWorkerPlacementPatchError: () => undefined,
}));

beforeEach(() => preparation.validate.mockReset());
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

it("offers an authorized recovery bound to the original chat and settings", async () => {
  const result = await prepare({ ...original });
  expect(result).toMatchObject({
    ok: false,
    error: {
      details: {
        code: "AGENT_RUNTIME_RESTRICTED",
        reason: "sandbox",
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
});

it.each([
  { tools: { fs: { workspaceOnly: true } }, reason: "workspace-only" },
  { tools: { deny: ["exec"] }, reason: "tool-policy" },
])("offers per-chat consent for optional $reason", async ({ tools, reason }) => {
  const entry = {
    ...original,
    agentRuntimeOverride: "native-fixture",
    permissionMode: "full" as const,
    sandboxMode: "off" as const,
  };
  expect(await prepare(entry, true, { tools })).toMatchObject({
    ok: false,
    error: {
      details: {
        reason,
        recovery: { action: "use-native-permissions", expectedNativeRuntimeConsent: null },
      },
    },
  });
  expect(
    (await prepare({ ...entry, nativeRuntimeConsent: "native-fixture" }, true, { tools })).ok,
  ).toBe(true);
  expect(
    (await prepare({ ...entry, nativeRuntimeConsent: "different-runtime" }, true, { tools })).ok,
  ).toBe(false);
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

it("allows an explicit local target despite a dormant node binding", async () => {
  expect(
    (
      await prepare(
        {
          ...original,
          sandboxMode: "off",
          permissionMode: "full",
          execHost: "gateway",
          execNode: "dormant-node",
        },
        true,
        { tools: { exec: { host: "node" } } },
      )
    ).ok,
  ).toBe(true);
});

it("accepts the explicitly unrestricted candidate without changing the agent config", async () => {
  const result = await prepare({ ...original, sandboxMode: "off", permissionMode: "full" });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected recovery selection");
  }
  expect(result.validate?.()).toBeUndefined();
  preparation.validate.mockReturnValue("Runtime owner changed");
  expect(result.validate?.()).toMatchObject({ message: "Runtime owner changed" });
  expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
});

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
