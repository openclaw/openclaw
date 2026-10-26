import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import * as modelRuntime from "../../auto-reply/reply/model-runtime-normalization.js";
import type { SessionEntry } from "../../config/sessions.js";
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

function restriction(result: Awaited<ReturnType<typeof prepare>>) {
  assert(!result.ok, "Expected native refusal");
  return result.error.details;
}

it.each([
  { reason: "sandbox", tools: undefined },
  { reason: "workspace-only", tools: { fs: { workspaceOnly: true } } },
  { reason: "tool-policy", tools: { deny: ["exec"] } },
])("offers chat-bound recovery for optional $reason", async ({ tools, reason }) => {
  const entry = tools ? unrestricted({ agentRuntimeOverride: "native-fixture" }) : { ...original };
  const config = tools ? { tools } : cfg;
  expect(restriction(await prepare(entry, true, config))).toMatchObject({
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
  });
  if (tools) {
    for (const consent of ["native-fixture", "different-runtime"]) {
      expect((await prepare({ ...entry, nativeRuntimeConsent: consent }, true, config)).ok).toBe(
        consent === "native-fixture",
      );
    }
  }
});

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

it("validates local selection with a dormant node", async () => {
  const result = await prepare(
    unrestricted({ execHost: "gateway", execNode: "dormant-node" }),
    true,
    { tools: { exec: { host: "node" } } },
  );
  assert(result.ok, "Expected recovery selection");
  expect(result.validate?.()).toBeUndefined();
  validate.mockReturnValue("Runtime owner changed");
  expect(result.validate?.()).toMatchObject({ message: "Runtime owner changed" });
});

it("preserves mandatory sandbox at creation", async () => {
  const entry = { ...original, sandbox: "required" as const };
  const details = restriction(await prepare(entry, false, cfg, { expectedEntry: undefined }));
  expect(details).toMatchObject({ reason: "sandbox-required" });
  expect(details).not.toHaveProperty("recovery");
  expect(entry.nativeRuntimeConsent).toBeUndefined();
});
