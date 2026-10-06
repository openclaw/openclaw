import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { resolveApprovedWorkerLocalModel, resolveApprovedWorkerModel } from "./inference-model.js";
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

describe("worker prompt credential-owned transcript policy", () => {
  it("approves a worker-local configured model without resolving Gateway credentials", async () => {
    const runtime = setup(sessionEntry, {
      config: structuredClone(configured),
      configuredRuntimeModel: model,
    });
    await using lease = await runtime.acquireRuntimeLease({
      config: configured,
      agentId: "runtime-agent",
      agentDir: "/gateway-agent",
      workspaceDir: WORKSPACE,
    });
    const approved = await resolveApprovedWorkerLocalModel({
      target: { ...params(request(), vi.fn()).sessionTarget, sessionEntry },
      modelRef,
      runtimeSnapshot: lease.snapshot,
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
      await using lease = await runtime.acquireRuntimeLease({
        config: configured,
        agentId: "runtime-agent",
        agentDir: "/gateway-agent",
        workspaceDir: WORKSPACE,
      });
      const approved = await resolveApprovedWorkerModel({
        target: { ...params(request(), vi.fn()).sessionTarget, sessionEntry },
        modelRef,
        runtimeSnapshot: lease.snapshot,
        assertCurrent: () => undefined,
      });
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
