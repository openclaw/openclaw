import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { resolveApprovedWorkerModel } from "./inference-model.js";
import {
  config,
  logicalModel,
  params,
  PROFILE,
  request,
  sessionEntry,
  setup,
  WORKSPACE,
} from "./inference-runtime.test-support.js";
import { prepareWorkerTurnModel } from "./worker-turn-model.js";

const model: Model = {
  ...logicalModel,
  id: "operator-update-fixture",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  params: { canonicalModelId: "opus" },
};
const modelRef = { provider: model.provider, model: model.id };
const modelKey = `${model.provider}/${model.id}`;
const configured: OpenClawConfig = {
  ...config,
  agents: {
    defaults: { model: { primary: modelKey }, models: { [modelKey]: {} } },
    entries: {
      "runtime-agent": { models: { [modelKey]: { agentRuntime: { id: "openclaw" } } } },
    },
  },
};
const requiredConfig = () => ({ ...config, cloudWorkers: { requiredProfile: "required" } });
const target = () => ({ ...params(request(), vi.fn()).sessionTarget, sessionEntry });
type Approval = Parameters<typeof resolveApprovedWorkerModel>[0];
async function modelFixture(
  options: Parameters<typeof setup>[1] = {},
  leaseConfig = options.config ?? requiredConfig(),
) {
  const runtime = setup(sessionEntry, { config: leaseConfig, ...options });
  const lease = await runtime.acquireRuntimeLease({
    config: leaseConfig,
    agentId: "runtime-agent",
    agentDir: "/gateway-agent",
    workspaceDir: WORKSPACE,
  });
  return Object.assign(lease, {
    runtime,
    approve: (overrides: Partial<Approval> = {}) =>
      resolveApprovedWorkerModel({
        target: target(),
        modelRef: request().modelRef,
        runtimeSnapshot: lease.snapshot,
        assertCurrent: () => undefined,
        ...overrides,
      }),
  });
}

it("forwards current required worker authority through real model preparation", async () => {
  await using fixture = await modelFixture();
  const { runtime } = fixture;
  const reached = new Error("admitted selected-model resolver reached");
  const resolver = vi.fn(() => Promise.reject(reached));
  runtime.prepareModel.mockImplementation((input, assertCurrent) =>
    prepareSimpleCompletionModel({ ...input, modelResolver: resolver }, assertCurrent),
  );
  const assertCurrent = vi.fn();
  await expect(fixture.approve({ assertCurrent })).rejects.toBe(reached);
  expect(resolver).toHaveBeenCalledOnce();
  expect(runtime.prepareModel).toHaveBeenCalledWith(
    expect.objectContaining({ workerInferenceAuthority: { assertCurrent } }),
  );
});

it.each(["wrong session", "revoked selection"] as const)(
  "rejects required worker %s before provider preparation",
  async (state) => {
    await using fixture = await modelFixture();
    const { runtime } = fixture;
    const selected = createDeferred();
    let current = true;
    if (state === "revoked selection") {
      runtime.resolveAuthSelection.mockImplementation(() => selected.promise.then(() => undefined));
    }
    const pending = fixture.approve({
      target: {
        ...target(),
        sessionEntry:
          state === "wrong session" ? { ...sessionEntry, sessionId: "other" } : sessionEntry,
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("worker claim revoked");
        }
      },
    });
    if (state === "wrong session") {
      expect(await pending).toBeUndefined();
    } else {
      current = false;
      selected.resolve();
      await expect(pending).rejects.toThrow("worker claim revoked");
    }
    expect(runtime.prepareModel).not.toHaveBeenCalled();
  },
);

it("approves a worker-local configured model without resolving Gateway credentials", async () => {
  await using fixture = await modelFixture(
    {
      config: { ...structuredClone(configured), cloudWorkers: { requiredProfile: "required" } },
      configuredRuntimeModel: model,
    },
    configured,
  );
  const approved = await prepareWorkerTurnModel({
    target: params(request(), vi.fn()).sessionTarget,
    modelRef,
    runtimeSnapshot: fixture.snapshot,
    inferencePlacement: "worker",
    turn: { config: fixture.snapshot.config, workspaceDir: WORKSPACE },
    assertCurrent: () => undefined,
  });
  assert(approved && !("error" in approved));
  expect(approved.model).toBe(model);
  expect(fixture.runtime.resolveAuthSelection).not.toHaveBeenCalled();
  expect(fixture.runtime.prepareModel).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses the resolved credential rather than config auth hints (OAuth=%s)",
  async (oauth) => {
    const metadataSnapshot = createEmptyPluginMetadataSnapshot(WORKSPACE);
    metadataSnapshot.owners.providerEndpoints = [
      { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
    ];
    await using fixture = await modelFixture({
      config: structuredClone(configured),
      metadataSnapshot,
    });
    const { runtime } = fixture;
    runtime.prepareModel.mockResolvedValue({
      model,
      auth: {
        apiKey: oauth ? ["sk", "ant", "oat01", "fixture"].join("-") : "synthetic-api-key",
        mode: "api-key",
        source: "synthetic worker policy fixture",
        profileId: PROFILE,
      },
    });
    const approved = await fixture.approve({ modelRef });
    assert(approved && !("error" in approved));
    expect(approved.transcriptPolicy.inHistorySystemUpdates).toBe(!oauth);
    expect(runtime.resolveAuthSelection).toHaveBeenCalledOnce();
    expect(runtime.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: model.provider, modelId: model.id, profileId: PROFILE }),
    );
  },
);
