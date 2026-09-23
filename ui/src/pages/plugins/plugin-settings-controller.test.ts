/* @vitest-environment jsdom */
import { render, type ReactiveController } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { createHarness } from "../model-providers/model-providers-page.test-support.ts";
import type { PluginCredentialEditor } from "./credential-editor.ts";
import { PluginSettingsController } from "./plugin-settings-controller.ts";
import { createInspectResult } from "./plugins-page.test-support.ts";
import type { PluginSettingsField } from "./settings-editor.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) {
    stop();
  }
  document.body.replaceChildren();
});
it.each(["legacy", "protected", "warning", "refresh-warning"])(
  "routes %s credential input to its actual writer",
  async (mode) => {
    const protectedStorage = mode !== "legacy";
    const warning = "Credential saved; runtime needs attention.";
    const harness = createHarness("main");
    await harness.runtimeConfig.ensureLoaded();
    const controllers: ReactiveController[] = [];
    const host = {
      addController: (controller: ReactiveController) => controllers.push(controller),
      removeController: () => {},
      requestUpdate: () => {},
      updateComplete: Promise.resolve(true),
    };
    const gateway = new GatewayPageController(host, { getGateway: () => harness.context.gateway });
    for (const controller of controllers) {
      controller.hostConnected?.();
    }
    cleanup.push(() => {
      for (const controller of controllers) {
        controller.hostDisconnected?.();
      }
    });
    const path = ["plugins", "entries", "example", "config", "apiKey"];
    const detail = {
      pluginId: "example",
      inspection: createInspectResult({
        credentials: [
          {
            path,
            label: "Example API key",
            envVars: [],
            ...(protectedStorage ? { storage: "protected" as const } : {}),
          },
        ],
      }),
      error: null,
    };
    const original = harness.request.getMockImplementation()!;
    harness.request.mockImplementation(async (method: string) =>
      method === "plugins.credentials.inspect"
        ? { baseHash: "hash", credential: { kind: "missing" } }
        : method === "plugins.credentials.set"
          ? { saved: true, ...(mode === "warning" ? { warning } : {}) }
          : original(method),
    );
    harness.context.runtimeConfig.runExternalMutation = async (task, options) => {
      if (options?.canDispatch?.() === false) {
        return { ok: false, reason: "rejected", error: "stale" };
      }
      return {
        ok: true,
        value: await task(harness.context.gateway.snapshot.client!),
        refresh: mode === "refresh-warning" ? { ok: false, error: warning } : { ok: true },
      };
    };
    let editable = true;
    const settings = new PluginSettingsController({
      gateway,
      getContext: () => harness.context,
      getDetail: () => detail,
      canInspect: () => true,
      canEdit: () => editable,
      onEdit: () => {},
      isSettings: () => true,
    });
    const onPatch = vi.fn(() => true);
    const field: PluginSettingsField = {
      schema: { type: "string" },
      value: undefined,
      path,
      hints: {},
      unsupported: new Set(),
      disabled: false,
      onPatch,
      label: "Example API key",
      property: "apiKey",
    };
    const container = document.createElement("div");
    document.body.append(container);
    render(settings.render(field), container);
    const editor = container.querySelector<PluginCredentialEditor>(
      "openclaw-plugin-credential-editor",
    )!;
    await editor.updateComplete;
    if (mode === "warning" || mode === "refresh-warning") {
      await vi.waitFor(() => expect(editor.textContent).not.toContain("Loading"));
      const input = editor.querySelector<HTMLInputElement>("input")!;
      input.value = "synthetic-input";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.waitFor(() => expect(editor.textContent).toContain(warning));
      expect(input.value).toBe("");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(
        harness.request.mock.calls.filter(([method]) => method === "plugins.credentials.set"),
      ).toHaveLength(1);
    } else {
      await editor.context.onCommit(path, "synthetic-input");
    }
    if (protectedStorage) {
      expect(harness.request).toHaveBeenCalledWith("plugins.credentials.set", {
        pluginId: "example",
        path,
        baseHash: "hash",
        value: "synthetic-input",
      });
      expect(onPatch).not.toHaveBeenCalled();
      const before = harness.request.mock.calls.length;
      editable = false;
      await expect(editor.context.onCommit(path, "synthetic-replacement")).rejects.toThrow("stale");
      expect(harness.request.mock.calls).toHaveLength(before);
    } else {
      expect(onPatch).toHaveBeenCalledWith(path, "synthetic-input");
      expect(
        harness.request.mock.calls.some(([method]) => method === "plugins.credentials.set"),
      ).toBe(false);
    }
  },
);
