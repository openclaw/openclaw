import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
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
const acquire = (runtime: ReturnType<typeof setup>, runtimeConfig: OpenClawConfig) =>
  runtime.acquireRuntimeLease({
    config: runtimeConfig,
    agentId: "runtime-agent",
    agentDir: "/gateway-agent",
    workspaceDir: WORKSPACE,
  });
const approve = (
  runtimeSnapshot: Parameters<typeof resolveApprovedWorkerModel>[0]["runtimeSnapshot"],
  overrides: Partial<Parameters<typeof resolveApprovedWorkerModel>[0]> = {},
) =>
  resolveApprovedWorkerModel({
    target: target(),
    modelRef,
    runtimeSnapshot,
    assertCurrent: () => undefined,
    ...overrides,
  });

describe("worker prompt credential-owned transcript policy", () => {
  it("forwards current required worker authority through real model preparation", async () => {
    const required = requiredConfig();
    const runtime = setup(sessionEntry, { config: required });
    const reached = new Error("admitted selected-model resolver reached");
    const resolver = vi.fn(async () => {
      throw reached;
    });
    runtime.prepareModel.mockImplementation((input, assertCurrent) =>
      prepareSimpleCompletionModel({ ...input, modelResolver: resolver }, assertCurrent),
    );
    await using lease = await acquire(runtime, required);
    const assertCurrent = vi.fn();
    await expect(
      approve(lease.snapshot, {
        modelRef: request().modelRef,
        assertCurrent,
      }),
    ).rejects.toBe(reached);
    expect(resolver).toHaveBeenCalledOnce();
    expect(runtime.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({
        workerInferenceAuthority: { assertCurrent },
      }),
    );
  });

  it.each(["wrong session", "revoked selection"] as const)(
    "rejects required worker %s before provider preparation",
    async (state) => {
      const required = requiredConfig();
      const runtime = setup(sessionEntry, { config: required });
      const selected = createDeferred();
      let current = true;
      if (state === "revoked selection") {
        runtime.resolveAuthSelection.mockImplementation(async () => {
          await selected.promise;
          return undefined;
        });
      }
      await using lease = await acquire(runtime, required);
      const pending = approve(lease.snapshot, {
        target: {
          ...target(),
          sessionEntry:
            state === "wrong session" ? { ...sessionEntry, sessionId: "other" } : sessionEntry,
        },
        modelRef: request().modelRef,
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
    const runtime = setup(sessionEntry, {
      config: { ...structuredClone(configured), cloudWorkers: { requiredProfile: "required" } },
      configuredRuntimeModel: model,
    });
    await using lease = await acquire(runtime, configured);
    const approved = await prepareWorkerTurnModel({
      target: params(request(), vi.fn()).sessionTarget,
      modelRef,
      runtimeSnapshot: lease.snapshot,
      inferencePlacement: "worker",
      turn: { config: lease.snapshot.config, workspaceDir: WORKSPACE },
      assertCurrent: () => undefined,
    });
    assert(approved && !("error" in approved));
    expect(approved.model).toBe(model);
    expect(runtime.resolveAuthSelection).not.toHaveBeenCalled();
    expect(runtime.prepareModel).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses the resolved credential rather than config auth hints (OAuth=%s)",
    async (oauth) => {
      const metadataSnapshot = createEmptyPluginMetadataSnapshot(WORKSPACE);
      const runtime = setup(sessionEntry, {
        config: structuredClone(configured),
        metadataSnapshot: {
          ...metadataSnapshot,
          owners: {
            ...metadataSnapshot.owners,
            providerEndpoints: [
              { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
            ],
          },
        },
      });
      runtime.prepareModel.mockResolvedValue({
        model,
        auth: {
          apiKey: oauth ? ["sk", "ant", "oat01", "fixture"].join("-") : "synthetic-api-key",
          mode: "api-key",
          source: "synthetic worker policy fixture",
          profileId: PROFILE,
        },
      });
      await using lease = await acquire(runtime, configured);
      const approved = await approve(lease.snapshot);
      assert(approved && !("error" in approved));
      expect(approved.transcriptPolicy.inHistorySystemUpdates).toBe(!oauth);
      expect(runtime.resolveAuthSelection).toHaveBeenCalledOnce();
      expect(runtime.prepareModel).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: model.provider,
          modelId: model.id,
          profileId: PROFILE,
        }),
      );
    },
  );
});
