/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { showToast } from "../../lib/toast.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { configGatewayAuth } from "./gateway-auth-draft.ts";

vi.mock(import("../../lib/toast.ts"), async (actual) => ({
  ...(await actual()),
  showToast: vi.fn(),
}));

type MutationOptions = { canDispatch?: () => boolean; dispatchError?: string };
type MutationResult =
  | { ok: true; value: unknown; refresh: { ok: true } }
  | { ok: false; reason: "conflict" | "rejected" | "unavailable"; error: string };

function mountAuthForm(
  auth: Record<string, unknown> = { mode: "token", token: REDACTED_SENTINEL },
) {
  const config = { gateway: { port: 18789, auth, trustedProxies: [] as string[] } };
  const state = {
    configForm: structuredClone(config),
    configSnapshot: { hash: "h1", config: structuredClone(config) },
    applySessionKey: "main",
  };
  const configListeners = new Set<() => void>();
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
    config: {},
    hash: "h2",
  }));
  // The write owner's contract: the dispatch guard runs right before the task goes out.
  const runExternalMutation = vi.fn(
    async (
      task: (client: unknown) => Promise<unknown>,
      options: MutationOptions,
    ): Promise<MutationResult> =>
      options.canDispatch?.() === false
        ? { ok: false, reason: "unavailable", error: options.dispatchError ?? "" }
        : { ok: true, value: await task({ request }), refresh: { ok: true } },
  );
  const gateway = {
    // Like the Gateway store: new credentials are a new connection, published synchronously.
    connect: vi.fn(() => {
      gateway.connectionRevision += 1;
      for (const listener of configListeners) {
        listener();
      }
    }),
    connectionRevision: 1,
    snapshot: { client: null, phase: "connected" as const },
  };
  const { connect } = gateway;
  const context = {
    runtimeConfig: {
      state,
      runExternalMutation,
      refresh: vi.fn(async () => undefined),
      subscribe: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    },
    gateway,
  };
  // SAFETY: The owner only touches the members this fixture provides.
  const gatewayAuth = configGatewayAuth(
    context as unknown as Parameters<typeof configGatewayAuth>[0],
  );
  // The generic form's own (autosaving) handlers.
  const autosaved = { onFormPatch: vi.fn(), onFormRemove: vi.fn() };
  const form = () => gatewayAuth.bindForm({ formValue: state.configForm, ...autosaved });
  const card = () => gatewayAuth.card(state.configForm);
  const edit = (path: Array<string | number>, value: unknown) => {
    form().onFormPatch(path, value);
    flush();
  };
  const stagePassword = () => {
    edit(["gateway", "auth", "mode"], "password");
    edit(["gateway", "auth", "password"], "correct-horse-battery");
  };
  const publish = () => {
    for (const listener of configListeners) {
      listener();
    }
    flush();
  };
  const saveElsewhere = (next: Record<string, unknown>) => {
    state.configSnapshot = { hash: "h9", config: { gateway: { ...config.gateway, auth: next } } };
  };
  return {
    form,
    card,
    edit,
    stagePassword,
    publish,
    saveElsewhere,
    autosaved,
    request,
    runExternalMutation,
    connect,
    gateway,
    state,
    context,
  };
}

describe("config page gateway auth form binding", () => {
  beforeEach(() => vi.mocked(showToast).mockClear());

  it("stages an auth mode change without writing or touching the autosaved draft", () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");

    expect(page.autosaved.onFormPatch).not.toHaveBeenCalled();
    expect(page.runExternalMutation).not.toHaveBeenCalled();
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
    expect(page.runExternalMutation).not.toHaveBeenCalled();
  });

  it("does not apply until the selected mode has its credential", async () => {
    const page = mountAuthForm();

    page.edit(["gateway", "auth", "mode"], "password");
    page.card().onApply();
    flush();
    await Promise.resolve();
    expect(page.runExternalMutation).not.toHaveBeenCalled();

    page.edit(["gateway", "auth", "password"], "correct-horse-battery");
    expect(page.card().issue).toBeNull();
  });

  it("applies mode and password in one patch and reconnects with the new password", async () => {
    const page = mountAuthForm();

    page.stagePassword();
    page.card().onApply();

    await vi.waitFor(() => expect(page.connect).toHaveBeenCalledTimes(1));
    flush();
    expect(page.request).toHaveBeenCalledTimes(1);
    const [method, sent] = page.request.mock.calls[0]!;
    expect(method).toBe("config.patch");
    expect(sent.baseHash).toBe("h1");
    expect(JSON.parse(String(sent.raw))).toEqual({
      gateway: { auth: { mode: "password", password: "correct-horse-battery" } },
    });
    expect(page.connect).toHaveBeenCalledWith({ password: "correct-horse-battery" });
    expect(page.card().staged).toBeNull();
    expect(page.autosaved.onFormPatch).not.toHaveBeenCalled();
    // Its own reconnect is not a connection the applied edit was lost to.
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });

  it("keeps the staged change and reports the failure when the Gateway rejects it", async () => {
    const page = mountAuthForm();
    page.runExternalMutation.mockResolvedValueOnce({
      ok: false,
      reason: "rejected",
      error: "Gateway authentication change rejected",
    });

    page.stagePassword();
    page.card().onApply();

    await vi.waitFor(() => {
      flush();
      expect(page.card().error).toBe("Gateway authentication change rejected");
    });
    expect(page.card().staged).toMatchObject({ mode: "password" });
    expect(page.connect).not.toHaveBeenCalled();
  });

  it("retries once on a fresh base when an unrelated save moved the config", async () => {
    const page = mountAuthForm();
    page.runExternalMutation.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      error: "config changed since last load",
    });

    page.stagePassword();
    page.card().onApply();

    await vi.waitFor(() => expect(page.connect).toHaveBeenCalledTimes(1));
    expect(page.context.runtimeConfig.refresh).toHaveBeenCalledTimes(1);
    expect(page.request).toHaveBeenCalledTimes(1);
  });

  it("drops a staged change, and its typed secret, when the Gateway connection changes", async () => {
    const page = mountAuthForm();
    page.stagePassword();

    // Another Gateway, or another sign-in on this one.
    page.gateway.connectionRevision = 2;
    page.publish();

    expect(page.card().staged).toBeNull();
    expect(page.form().formValue).toMatchObject({ gateway: { auth: { mode: "token" } } });
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "error" }),
    );
    page.card().onApply();
    await Promise.resolve();
    expect(page.runExternalMutation).not.toHaveBeenCalled();
    expect(page.connect).not.toHaveBeenCalled();
  });

  it("does not send a staged change over auth that was saved differently meanwhile", async () => {
    const page = mountAuthForm();
    page.stagePassword();

    page.saveElsewhere({ mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" } });
    page.card().onApply();

    await vi.waitFor(() => {
      flush();
      // Settings copy is not registered here, so the message renders as its key.
      expect(page.card().error).toContain("gatewayAuth.changedElsewhere");
    });
    expect(page.request).not.toHaveBeenCalled();
    expect(page.connect).not.toHaveBeenCalled();
    expect(page.card().staged).toBeNull();
  });

  it("keeps a staged change across pages for the same config owner", () => {
    const page = mountAuthForm();
    page.stagePassword();

    // SAFETY: Same fixture context as above.
    const again = configGatewayAuth(
      page.context as unknown as Parameters<typeof configGatewayAuth>[0],
    );

    expect(again.card(page.state.configForm).staged).toMatchObject({ mode: "password" });
  });
});
