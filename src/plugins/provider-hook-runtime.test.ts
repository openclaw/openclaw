import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { getModelProviderLocalServiceReconciler } from "../agents/provider-local-service-reconcile.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import {
  bindModelCompletionOwner,
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { attachModelProviderRuntimePluginHandle } from "./provider-hook-runtime.js";

it("clears a stale local-service reconciler when the prepared provider changes", () => {
  const reconcile = vi.fn(async () => undefined);
  const withReconciler = attachModelProviderRuntimePluginHandle(
    { id: "demo", provider: "local", baseUrl: "http://127.0.0.1:1/v1" },
    { plugin: { reconcileLocalService: reconcile } } as never,
  );
  const withoutReconciler = attachModelProviderRuntimePluginHandle(withReconciler, {
    plugin: {},
  } as never);

  expect(getModelProviderLocalServiceReconciler(withReconciler)).toBe(reconcile);
  expect(getModelProviderLocalServiceReconciler(withoutReconciler)).toBeUndefined();
});

it("preserves the runtime and completion owner when attaching a provider handle", () => {
  const runtime = createLlmRuntime(createApiRegistry());
  const completionTransport = makeProviderModelFixture({
    id: "completion-transport",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
  });
  const completionOwner = {
    run: async <T>(run: () => Promise<T>) => await run(),
    assertCurrent: vi.fn(),
  };
  const model = bindModelCompletionOwner(
    bindModelLlmRuntime({ ...completionTransport, id: "model" }, runtime, completionTransport),
    completionOwner,
  );
  const prepared = attachModelProviderRuntimePluginHandle(model, {
    provider: model.provider,
    modelId: model.id,
    plugin: undefined,
  });

  expect(getModelLlmRuntime(prepared)).toBe(runtime);
  expect(getModelCompletionTransport(prepared)).toBe(completionTransport);
  expect(getModelCompletionOwner(prepared)).toBe(completionOwner);
});
