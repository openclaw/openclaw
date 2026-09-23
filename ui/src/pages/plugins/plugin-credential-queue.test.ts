/* @vitest-environment jsdom */
import { render, type ReactiveController } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { DecisionModelSetupController } from "../model-providers/decision-setup-controller.ts";
import { createHarness } from "../model-providers/model-providers-page.test-support.ts";
import type { PluginCredentialEditor } from "./credential-editor.ts";
import { PluginSettingsController } from "./plugin-settings-controller.ts";
import { createInspectResult } from "./plugins-page.test-support.ts";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) {
    stop();
  }
  document.body.replaceChildren();
});
it.each(
  (["plugin", "decision"] as const).flatMap((entry) =>
    ["advanced", "hashless", "failed-hashless", "reconnect"].map((outcome) => ({ entry, outcome })),
  ),
)("$entry credential handles $outcome in the real serialized queue", async ({ entry, outcome }) => {
  const h = createHarness("main");
  const runtime = createRuntimeConfigCapability(h.context.gateway);
  const context = { ...h.context, runtimeConfig: runtime };
  cleanups.push(() => runtime.dispose());
  const write = createDeferred();
  let hash: string | undefined = "before";
  let config: Record<string, unknown> = { agents: { defaults: { thinkingDefault: "low" } } };
  h.request.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return { config, raw: JSON.stringify(config), hash, valid: true, issues: [] };
    }
    if (method === "config.set") {
      await write.promise;
      if (outcome === "failed-hashless") {
        hash = undefined;
        runtime.state.configSnapshot = null;
        throw new Error("Settings write refused");
      }
      config = JSON.parse((params as { raw: string }).raw);
      hash = outcome === "hashless" ? undefined : "after-settings-write";
      return { config, hash };
    }
    if (method === "plugins.credentials.set") {
      if ((params as { baseHash: string }).baseHash !== hash) {
        throw new Error("stale credential revision");
      }
      return { saved: true };
    }
    if (method === "models.list") {
      return { models: [], decisionModels: [model] };
    }
    if (method === "plugins.credentials.inspect") {
      return { baseHash: hash, credential: { kind: "missing" } };
    }
    return {};
  });
  await runtime.ensureLoaded();
  const mutations = vi.spyOn(runtime, "runExternalMutation");
  const path = ["plugins", "entries", "fixture", "config", "apiKey"];
  const model: DecisionModelEntry = {
    provider: "fixture",
    id: "fast",
    name: "Fast",
    pluginId: "fixture",
    readiness: "setup-required",
    setup: { kind: "api-key", label: "Fixture", help: "Add a key", credentialPath: path },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const controllers: ReactiveController[] = [];
  let update = () => {};
  const host = {
    addController: (c: ReactiveController) => controllers.push(c),
    removeController: () => {},
    requestUpdate: () => update(),
    updateComplete: Promise.resolve(true),
  };
  let submit: () => Promise<unknown>;
  if (entry === "decision") {
    const controller = new DecisionModelSetupController(host, {
      getScope: () => ({ context, agentId: "main" }),
      getModels: () => [model],
      getSelection: () => null,
    });
    update = () => render(controller.render(), container);
    controller.choose("fixture/fast", vi.fn());
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "synthetic-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submit = async () => {
      container.querySelector<HTMLButtonElement>("button.primary")!.click();
      await mutations.mock.results[0]!.value;
    };
  } else {
    const gateway = new GatewayPageController(host, { getGateway: () => h.context.gateway });
    for (const c of controllers) {
      c.hostConnected?.();
    }
    cleanups.push(() => {
      for (const c of controllers) {
        c.hostDisconnected?.();
      }
    });
    const detail = {
      pluginId: "fixture",
      inspection: createInspectResult({
        credentials: [{ path, label: "API key", envVars: [], storage: "protected" }],
      }),
      error: null,
    };
    const settings = new PluginSettingsController({
      gateway,
      getContext: () => context,
      getDetail: () => detail,
      canInspect: () => true,
      canEdit: () => true,
      onEdit: () => {},
      isSettings: () => true,
    });
    render(
      settings.render({
        schema: { type: "string" },
        value: undefined,
        path,
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch: () => true,
        label: "API key",
        property: "apiKey",
      }),
      container,
    );
    const editor = container.querySelector<PluginCredentialEditor>(
      "openclaw-plugin-credential-editor",
    )!;
    await editor.updateComplete;
    submit = () => editor.context.onCommit(path, "synthetic-key");
  }
  runtime.patchForm(["agents", "defaults", "thinkingDefault"], "high");
  const completion = submit();
  const settled = completion.catch((error: unknown) => error);
  await waitForFast(() =>
    expect(h.request.mock.calls.some(([method]) => method === "config.set")).toBe(true),
  );
  expect(h.request.mock.calls.some(([method]) => method === "plugins.credentials.set")).toBe(false);
  if (outcome === "reconnect") {
    h.publishPhase("offline");
  }
  write.resolve();
  await settled;
  if (outcome !== "advanced") {
    expect(h.request.mock.calls.some(([method]) => method === "plugins.credentials.set")).toBe(
      false,
    );
    expect(await mutations.mock.results[0]!.value).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
    return;
  }
  expect(h.request).toHaveBeenCalledWith("plugins.credentials.set", {
    pluginId: "fixture",
    path,
    baseHash: "after-settings-write",
    value: "synthetic-key",
  });
  expect(await mutations.mock.results[0]!.value).toMatchObject({ ok: true });
});
