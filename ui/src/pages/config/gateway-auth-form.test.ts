/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createConfigGatewayAuth } from "./gateway-auth-draft.ts";

type PatchBuild = (config: Readonly<Record<string, unknown>>) => {
  options: { raw: unknown; replacePaths?: string[] };
};

function mountAuthForm(
  auth: Record<string, unknown> = { mode: "token", token: REDACTED_SENTINEL },
) {
  const config = { gateway: { port: 18789, auth, trustedProxies: [] as string[] } };
  const state = { configForm: structuredClone(config), lastError: null as string | null };
  const patchFromSnapshot = vi.fn(async (_build: PatchBuild) => true);
  const connect = vi.fn();
  const context = {
    runtimeConfig: { state, patchFromSnapshot },
    gateway: { connect },
  } as unknown as Pick<ApplicationContext, "runtimeConfig" | "gateway">;
  const gatewayAuth = createConfigGatewayAuth(context);
  // The generic form's own (autosaving) handlers.
  const autosaved = { onFormPatch: vi.fn(), onFormRemove: vi.fn() };
  const form = () => gatewayAuth.bindForm({ formValue: state.configForm, ...autosaved });
  const card = () => gatewayAuth.card(state.configForm);
  const edit = (path: Array<string | number>, value: unknown) => {
    form().onFormPatch(path, value);
    flush();
  };
  const sentPatch = () => patchFromSnapshot.mock.calls[0]?.[0](config).options;
  return { form, card, edit, autosaved, patchFromSnapshot, connect, state, sentPatch };
}

describe("config page gateway auth form binding", () => {
  it("stages an auth mode change without writing or touching the autosaved draft", () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");

    expect(page.autosaved.onFormPatch).not.toHaveBeenCalled();
    expect(page.patchFromSnapshot).not.toHaveBeenCalled();
    expect(page.card().staged).toMatchObject({ mode: "password" });
    expect(page.card().issue).toBe("passwordRequired");
    // The form shows the staged mode while the shared draft keeps the saved one.
    expect(page.form().formValue).toMatchObject({ gateway: { auth: { mode: "password" } } });
    expect(page.state.configForm.gateway.auth.mode).toBe("token");
  });

  it("keeps unrelated edits on the autosave path without the pending auth draft", () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");
    page.edit(["gateway", "port"], 18790);
    page.form().onFormRemove(["gateway", "auth", "rateLimit"]);
    flush();

    expect(page.autosaved.onFormPatch).toHaveBeenCalledTimes(1);
    expect(page.autosaved.onFormPatch).toHaveBeenCalledWith(["gateway", "port"], 18790);
    expect(page.autosaved.onFormRemove).not.toHaveBeenCalled();
    expect(page.card().staged).toMatchObject({ mode: "password" });
  });

  it("cancels back to the saved mode", () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");
    page.card().onCancel();
    flush();

    expect(page.card().staged).toBeNull();
    expect(page.form().formValue).toMatchObject({ gateway: { auth: { mode: "token" } } });
    expect(page.patchFromSnapshot).not.toHaveBeenCalled();
  });

  it("does not apply until the selected mode has its credential", async () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");
    page.card().onApply();
    flush();
    await Promise.resolve();
    expect(page.patchFromSnapshot).not.toHaveBeenCalled();

    page.edit(["gateway", "auth", "password"], "correct-horse-battery");
    expect(page.card().issue).toBeNull();
  });

  it("applies mode and password in one patch and reconnects with the new password", async () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");
    page.edit(["gateway", "auth", "password"], "correct-horse-battery");
    page.card().onApply();

    await vi.waitFor(() => expect(page.connect).toHaveBeenCalledTimes(1));
    flush();
    expect(page.patchFromSnapshot).toHaveBeenCalledTimes(1);
    expect(page.sentPatch()?.raw).toEqual({
      gateway: { auth: { mode: "password", password: "correct-horse-battery" } },
    });
    expect(page.connect).toHaveBeenCalledWith({ password: "correct-horse-battery" });
    expect(page.card().staged).toBeNull();
    expect(page.autosaved.onFormPatch).not.toHaveBeenCalled();
  });

  it("keeps the staged change and reports the failure when the Gateway rejects it", async () => {
    const page = mountAuthForm();
    page.patchFromSnapshot.mockResolvedValueOnce(false);
    page.state.lastError = "Gateway authentication change rejected";

    page.edit(["gateway", "auth", "mode"], "password");
    page.edit(["gateway", "auth", "password"], "correct-horse-battery");
    page.card().onApply();

    await vi.waitFor(() => {
      flush();
      expect(page.card().error).toBe("Gateway authentication change rejected");
    });
    expect(page.card().staged).toMatchObject({ mode: "password" });
    expect(page.connect).not.toHaveBeenCalled();
  });
});
