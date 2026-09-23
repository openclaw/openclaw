/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { DecisionModelSetupController } from "./decision-setup-controller.ts";
import { createHarness } from "./model-providers-page.test-support.ts";

const model: DecisionModelEntry = {
  provider: "fixture",
  id: "fast",
  name: "Fast decisions",
  pluginId: "fixture",
  readiness: "setup-required",
  setup: {
    kind: "api-key",
    label: "Fixture",
    help: "Add a key",
    credentialPath: ["plugins", "entries", "fixture", "config", "apiKey"],
  },
};
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function fixture() {
  const harness = createHarness("writer");
  await harness.runtimeConfig.ensureLoaded();
  let selection: string | null = "local/previous";
  let agentId = "main";
  let models = [model];
  const container = document.createElement("div");
  document.body.append(container);
  const host = {
    addController: vi.fn(),
    removeController: vi.fn(),
    updateComplete: Promise.resolve(true),
    requestUpdate: () => render(controller.render(), container),
  };
  const controller = new DecisionModelSetupController(host, {
    getScope: () => ({ context: harness.context, agentId }),
    getModels: () => models,
    getSelection: () => selection,
  });
  const commit = vi.fn((value: string | null) => {
    selection = value;
  });
  const original = harness.request.getMockImplementation()!;
  harness.request.mockImplementation(async (method: string) => {
    if (method === "models.list") {
      return { models: [], decisionModels: models };
    }
    return original(method);
  });
  harness.context.runtimeConfig.runExternalMutation = async (task, options) => {
    if (options?.canDispatch?.() === false) {
      return { ok: false, reason: "rejected", error: "stale" };
    }
    const value = await task(harness.context.gateway.snapshot.client!);
    return { ok: true, value, refresh: { ok: true } };
  };
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label,
    )!;
  const enter = () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(false);
    input.value = "synthetic-input";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return {
    ...harness,
    controller,
    container,
    commit,
    button,
    enter,
    get selection() {
      return selection;
    },
    setSelection: (value: string) => {
      selection = value;
      host.requestUpdate();
    },
    switchAgent: () => {
      agentId = "other";
      host.requestUpdate();
    },
    ready: () => {
      models = [{ ...model, readiness: "configured" }];
    },
    setModels: (value: DecisionModelEntry[]) => {
      models = value;
    },
    original,
  };
}
it("keeps previous selection through missing, rejected and cancelled setup", async () => {
  const f = await fixture();
  f.controller.choose("fixture/fast", f.commit);
  expect(f.button("Connect Fixture").disabled).toBe(true);
  expect(f.selection).toBe("local/previous");
  f.enter();
  f.request.mockRejectedValueOnce(new Error("Credential rejected"));
  f.button("Connect Fixture").click();
  await waitForFast(() => expect(f.container.textContent).toContain("Credential rejected"));
  expect(f.commit).not.toHaveBeenCalled();
  f.button("Cancel").click();
  expect(f.container.querySelector("[data-models-key-dialog]")).toBeNull();
  expect(f.selection).toBe("local/previous");
});
it("retains exact intent after protected save and requires explicit confirmation", async () => {
  const f = await fixture();
  f.controller.choose("fixture/fast", f.commit);
  f.enter();
  f.request.mockImplementation(async (method: string) => {
    if (method === "plugins.credentials.set") {
      f.ready();
      return { saved: true };
    }
    if (method === "models.list") {
      return { models: [], decisionModels: [{ ...model, readiness: "configured" }] };
    }
    return f.original(method);
  });
  f.button("Connect Fixture").click();
  await waitForFast(() => expect(f.button("Use Fast decisions")).toBeDefined());
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.selection).toBe("local/previous");
  expect(f.request).toHaveBeenCalledWith(
    "plugins.credentials.set",
    expect.objectContaining({
      pluginId: "fixture",
      path: model.setup?.credentialPath,
      value: "synthetic-input",
      baseHash: expect.any(String),
    }),
  );
  f.button("Use Fast decisions").click();
  expect(f.commit).toHaveBeenCalledExactlyOnceWith("fixture/fast");
});
it("provider-only connection never selects a decision model", async () => {
  const f = await fixture();
  f.controller.open(model);
  f.enter();
  f.request.mockImplementation(async (method: string) =>
    method === "plugins.credentials.set"
      ? { saved: true }
      : method === "models.list"
        ? { models: [], decisionModels: [{ ...model, readiness: "configured" }] }
        : f.original(method),
  );
  f.button("Connect Fixture").click();
  await waitForFast(() => expect(f.controller.busy).toBe(false));
  expect(f.selection).toBe("local/previous");
  expect(f.commit).not.toHaveBeenCalled();
});
it.each(["agent", "selection", "unmount"])(
  "does not publish late setup into a changed %s",
  async (change) => {
    const f = await fixture();
    const saved = createDeferred<{ saved: true }>();
    f.request.mockImplementation(async (method: string) =>
      method === "plugins.credentials.set" ? saved.promise : f.original(method),
    );
    f.controller.choose("fixture/fast", f.commit);
    f.enter();
    f.button("Connect Fixture").click();
    if (change === "agent") {
      f.switchAgent();
    } else if (change === "selection") {
      f.setSelection("other/current");
    } else {
      f.controller.hostDisconnected();
    }
    saved.resolve({ saved: true });
    await saved.promise;
    await waitForFast(() => expect(f.controller.busy).toBe(false));
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.container.textContent).not.toContain("Use Fast decisions");
  },
);
it("uses already configured models normally and never asks local models for keys", async () => {
  const f = await fixture();
  f.ready();
  f.controller.choose("fixture/fast", f.commit);
  expect(f.commit).toHaveBeenCalledExactlyOnceWith("fixture/fast");
  f.commit.mockClear();
  const local: DecisionModelEntry = {
    provider: "local",
    id: "cpu",
    name: "Local CPU",
    pluginId: "local",
    readiness: "unknown",
    setup: { kind: "local-model", label: "Local", help: "Download the model first" },
  };
  f.setModels([local]);
  f.controller.choose("local/cpu", f.commit);
  expect(f.container.querySelector("input[type=password]")).toBeNull();
  expect(f.container.textContent).toContain("Download the model first");
  expect(f.commit).not.toHaveBeenCalled();
  f.button("Cancel").click();
  expect(f.selection).toBe("fixture/fast");
});
it.each(["local-model", "local-server"] as const)(
  "never commits unknown %s setup and permits explicit confirmation only after refresh",
  async (kind) => {
    const f = await fixture();
    const local: DecisionModelEntry = {
      ...model,
      readiness: "unknown",
      setup: { kind, label: "Local", help: "Complete local setup" },
    };
    f.setModels([local]);
    f.controller.choose("fixture/fast", f.commit);
    expect(f.button("Use Fast decisions")).toBeUndefined();
    expect(f.container.querySelector("input[type=password]")).toBeNull();
    f.button("Refresh setup status").click();
    await waitForFast(() =>
      expect(f.request).toHaveBeenCalledWith("models.list", expect.any(Object)),
    );
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.selection).toBe("local/previous");
    f.setModels([{ ...local, readiness: "configured" }]);
    f.button("Refresh setup status").click();
    await waitForFast(() => expect(f.button("Use Fast decisions")).toBeDefined());
    expect(f.commit).not.toHaveBeenCalled();
    f.button("Use Fast decisions").click();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith("fixture/fast");
  },
);
it("does not confuse a saved but unavailable credential with a usable selection", async () => {
  const f = await fixture();
  f.controller.choose("fixture/fast", f.commit);
  f.enter();
  f.request.mockImplementation(async (method: string) =>
    method === "plugins.credentials.set"
      ? { saved: true }
      : method === "models.list"
        ? { models: [], decisionModels: [model] }
        : f.original(method),
  );
  f.button("Connect Fixture").click();
  await waitForFast(() =>
    expect(f.container.textContent).toContain(
      "API key saved, but this provider is not available yet",
    ),
  );
  expect(f.button("Use Fast decisions")).toBeUndefined();
  expect(f.commit).not.toHaveBeenCalled();
});
