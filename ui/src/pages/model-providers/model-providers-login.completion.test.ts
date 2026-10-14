/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness, openLogin } from "./model-providers-login.test-support.ts";
import { appendPage, submitCredential, unmountPage } from "./model-providers-page.test-support.tsx";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("offers the verified starter while config reconciliation is still pending", async () => {
  const { context, answer } = loginHarness();
  const refresh = deferred();
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
  await openLogin(page);
  await submitCredential(page, "synthetic-key");
  answer.resolve({
    done: true,
    status: "done",
    modelActivation: { modelRef: "example/verified" },
  });
  try {
    await waitForSolid(() =>
      expect(page.querySelector("[data-login-start-chat]")?.textContent).toBe(
        "Start a new chat with example/verified",
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-login-start-chat]")!.click();
    await waitForSolid(() =>
      expect(create).toHaveBeenCalledWith({ agentId: "writer", model: "example/verified" }),
    );
  } finally {
    refresh.resolve();
    unmountPage(page);
  }
});
