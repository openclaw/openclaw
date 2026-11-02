/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  museCodeCapability,
  loginHarness,
  openPicker,
  selectProvider,
} from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  startSelectedLogin,
  submitCredential,
  unmountPage,
} from "./model-providers-page.test-support.tsx";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("shows distinct verification and activation phases before offering the named Muse starter", async () => {
  const { context, request, answer } = loginHarness({ capabilities: [museCodeCapability()] });
  const refresh = deferred();
  const activation = deferred<WizardNextResult>();
  const completion = deferred<WizardNextResult>();
  const loginRequest = request.getMockImplementation()!;
  let nextRequests = 0;
  const steps = new Map([
    [3, activation.promise],
    [4, completion.promise],
  ]);
  request.mockImplementation(async (method) => {
    const step = method === "wizard.next" ? steps.get(++nextRequests) : undefined;
    return step ?? loginRequest(method);
  });
  context.runtimeConfig.runExternalMutation = async (task) => {
    const value = await task(context.gateway.snapshot.client!);
    if (value) {
      await refresh.promise;
    }
    return { ok: true, value, refresh: { ok: true } };
  };
  const create = vi.fn(async () => null);
  Object.assign(context, { sessions: { create, state: {} } });
  const page = appendPage(context);
  const text = (selector: string) => page.querySelector(selector)?.textContent;
  const starter = () => page.querySelector<HTMLButtonElement>("[data-login-start-chat]");
  async function showProgress(step: typeof answer, id: string, message: string) {
    step.resolve({
      done: false,
      status: "running",
      step: { id, type: "progress", executor: "gateway", message },
    });
    await waitForSolid(() =>
      expect(text(".wizard-step__progress[role='status']")?.trim()).toBe(message),
    );
    expect(starter()).toBeNull();
  }
  await openPicker(page);
  await selectProvider(page, "meta");
  await startSelectedLogin(page, "Muse Code");
  await submitCredential(page);
  try {
    await showProgress(answer, "verification", "Testing your AI connection…");
    await showProgress(activation, "activation", "Turning on your AI connection…");
    expect(text(".model-setup-wizard")).not.toContain("Testing your AI connection…");
    completion.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/muse-spark-1.3", modelName: "Muse Spark 1.3" },
    });
    await waitForSolid(() =>
      expect(starter()?.textContent).toBe("Start a new chat with Muse Spark 1.3"),
    );
    expect(text(".model-setup-wizard__success-title")).toBe("Muse Code is connected");
    expect(text(".model-setup-wizard__success-description")).toBe(
      "Muse Spark 1.3 is ready for your agent.",
    );
    expect(text(".model-setup-wizard")).not.toContain("meta/muse-spark-1.3");
    starter()!.click();
    await waitForSolid(() =>
      expect(create).toHaveBeenCalledWith(
        { agentId: "writer", model: "meta/muse-spark-1.3" },
        { signal: expect.any(AbortSignal) },
      ),
    );
  } finally {
    activation.resolve({ done: true, status: "cancelled" });
    completion.resolve({ done: true, status: "cancelled" });
    refresh.resolve();
    unmountPage(page);
  }
});
