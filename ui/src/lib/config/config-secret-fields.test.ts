import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { showToast } from "../toast.ts";
import { configSecretFields } from "./config-secret-fields.ts";

vi.mock(import("../toast.ts"), async (actual) => ({ ...(await actual()), showToast: vi.fn() }));

function fixture() {
  const routerListeners = new Set<(state: { location: { pathname: string } }) => void>();
  const configListeners = new Set<() => void>();
  const request = vi.fn(async () => ({ ok: true, config: {}, hash: "h2" }));
  const runExternalMutation = vi.fn(async (task: (client: unknown) => Promise<unknown>) => ({
    ok: true as const,
    value: await task({ request }),
    refresh: { ok: true as const },
  }));
  const gateway = {
    connectionRevision: 1,
    snapshot: { client: null, phase: "connected" as const },
  };
  const context = {
    gateway,
    navigate: vi.fn(),
    router: {
      getState: () => ({
        location: { pathname: "/settings/advanced", search: "?section=gateway" },
        matches: [{ routeId: "advanced" }],
      }),
      subscribe: (listener: (state: { location: { pathname: string } }) => void) => {
        routerListeners.add(listener);
        return () => routerListeners.delete(listener);
      },
    },
    runtimeConfig: {
      state: {
        configSnapshot: { hash: "h1", config: { gateway: { port: 1 } } },
        configForm: { gateway: { port: 2 } },
        applySessionKey: "main",
      },
      refresh: vi.fn(async () => undefined),
      runExternalMutation,
      subscribe: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    },
  };
  // SAFETY: The owner only touches the members this fixture provides.
  const fields = configSecretFields(context as unknown as Parameters<typeof configSecretFields>[0]);
  return { context, fields, gateway, request, runExternalMutation, configListeners };
}

describe("configSecretFields", () => {
  const path = ["gateway", "auth", "token"];

  it("holds an edit outside the draft and writes it only on save", async () => {
    const { context, fields, request } = fixture();
    fields.hold(path, "abc", "Token");
    expect(fields.read(path)).toBe("abc");
    expect(request).not.toHaveBeenCalled();
    expect(context.runtimeConfig.state.configForm).toEqual({ gateway: { port: 2 } });

    await expect(fields.save(path, "abc")).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "h1",
        raw: JSON.stringify({ gateway: { auth: { token: "abc" } } }),
      }),
    );
  });

  it("keeps array rows apart", () => {
    const { fields } = fixture();
    fields.hold(["rules", 0, "token"], "a", "Token");
    fields.hold(["rules", 1, "token"], "b", "Token");
    expect(fields.read(["rules", 0, "token"])).toBe("a");
    expect(fields.read(["rules", 1, "token"])).toBe("b");
  });

  it("never carries an edit to a different Gateway", () => {
    const { fields, gateway, configListeners } = fixture();
    const changed = vi.fn();
    fields.hold(path, "abc", "Token");
    fields.subscribe(changed);
    gateway.connectionRevision = 2;
    for (const listener of configListeners) {
      listener();
    }
    expect(fields.read(path)).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    // The edit is dropped, and the person is told which field lost it.
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "configForm.secretDroppedOnConnectionChange" }),
    );
  });

  it("refuses a secret in a list while unsaved rows moved under it", async () => {
    const { context, fields, request } = fixture();
    const rulePath = ["hooks", "rules", 0, "token"];
    const rules = [{ name: "a" }, { name: "b" }];
    // SAFETY: The fixture's snapshot and draft only need the members the owner reads.
    context.runtimeConfig.state.configSnapshot = {
      hash: "h1",
      config: { hooks: { rules } },
    } as never;
    // Row a was removed in the draft, so the field typed on row 0 belongs to b.
    context.runtimeConfig.state.configForm = { hooks: { rules: [rules[1]] } } as never;
    fields.hold(rulePath, "abc", "Token");
    await expect(fields.save(rulePath, "abc")).resolves.toEqual({
      ok: false,
      error: "configForm.draftRejected",
    });
    expect(request).not.toHaveBeenCalled();
    expect(fields.read(rulePath)).toBe("abc");
  });

  it("retries once against the latest config after a conflict", async () => {
    const { context, fields, runExternalMutation } = fixture();
    runExternalMutation.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      error: "Config changed",
    } as never);
    await expect(fields.save(path, "abc")).resolves.toEqual({ ok: true });
    expect(context.runtimeConfig.refresh).toHaveBeenCalledTimes(1);
    expect(runExternalMutation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a secret on another Gateway after a held conflict refresh", async () => {
    const { context, fields, gateway, request, runExternalMutation } = fixture();
    const refreshing = createDeferred();
    const resume = createDeferred();
    fields.hold(path, "secret-for-a", "Token");
    runExternalMutation.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      error: "Config changed",
    } as never);
    context.runtimeConfig.refresh.mockImplementationOnce(async () => {
      refreshing.resolve();
      await resume.promise;
    });
    const save = fields.save(path, "secret-for-a");
    await refreshing.promise;
    gateway.connectionRevision = 2;
    fields.hold(path, "secret-for-b", "Token");
    resume.resolve();
    await expect(save).resolves.toEqual({ ok: false, error: "" });
    expect(request).not.toHaveBeenCalled();
    expect(fields.read(path)).toBe("secret-for-b");
  });

  it("reports a refusal without touching the held edit", async () => {
    const { fields, runExternalMutation } = fixture();
    fields.hold(path, "abc", "Token");
    runExternalMutation.mockResolvedValueOnce({
      ok: false,
      reason: "rejected",
      error: "Token format is invalid",
    } as never);
    await expect(fields.save(path, "abc")).resolves.toEqual({
      ok: false,
      error: "Token format is invalid",
    });
    expect(fields.read(path)).toBe("abc");
  });

  describe("a value that turns into a reference while the edit is held", () => {
    const savedAs = (token: unknown) => ({
      hash: "h2",
      config: { gateway: { port: 1, auth: { token } } },
    });

    it.each([
      ["a stored secret", "__OPENCLAW_REDACTED__"],
      ["a SecretRef", { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" }],
      ["a ${VAR} the field wasn't showing", "${GATEWAY_TOKEN}"],
      ["a template the field wasn't showing", "Bearer ${GATEWAY_TOKEN}"],
    ])("drops the edit and never writes over %s", async (_name, saved) => {
      const { context, fields, request, configListeners } = fixture();
      fields.hold(path, "abc", "Token");
      const changed = vi.fn();
      fields.subscribe(changed);
      // SAFETY: The fixture's snapshot only needs the members the owner reads.
      context.runtimeConfig.state.configSnapshot = savedAs(saved) as never;
      for (const listener of configListeners) {
        listener();
      }
      expect(fields.read(path)).toBeUndefined();
      expect(changed).toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      ["a stored secret", "__OPENCLAW_REDACTED__"],
      ["a SecretRef", { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" }],
      ["a ${VAR} the field wasn't showing", "${GATEWAY_TOKEN}"],
    ])("checks again on Save, before the patch goes out, for %s", async (_name, saved) => {
      const { context, fields, request } = fixture();
      fields.hold(path, "abc", "Token");
      // The change lands without a notification yet, so only Save's own check can see it.
      context.runtimeConfig.state.configSnapshot = savedAs(saved) as never;
      await expect(fields.save(path, "abc")).resolves.toEqual({ ok: false, error: "" });
      expect(request).not.toHaveBeenCalled();
      expect(fields.read(path)).toBeUndefined();
    });

    it("refuses when the reference lands between a conflict and the retry", async () => {
      const { context, fields, request, runExternalMutation } = fixture();
      fields.hold(path, "abc", "Token");
      runExternalMutation.mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        error: "Config changed",
      } as never);
      context.runtimeConfig.refresh.mockImplementationOnce(async () => {
        context.runtimeConfig.state.configSnapshot = savedAs("${GATEWAY_TOKEN}") as never;
      });
      await expect(fields.save(path, "abc")).resolves.toEqual({ ok: false, error: "" });
      expect(runExternalMutation).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(fields.read(path)).toBeUndefined();
    });

    it("still writes over the ${VAR} the field showed when typing began", async () => {
      const { context, fields, request } = fixture();
      context.runtimeConfig.state.configSnapshot = savedAs("${GATEWAY_TOKEN}") as never;
      fields.hold(path, "abc", "Token");
      await expect(fields.save(path, "abc")).resolves.toEqual({ ok: true });
      expect(request).toHaveBeenCalledWith(
        "config.patch",
        expect.objectContaining({ raw: JSON.stringify({ gateway: { auth: { token: "abc" } } }) }),
      );
    });

    it("keeps the edit while the snapshot is being re-read", () => {
      const { context, fields, configListeners } = fixture();
      fields.hold(path, "abc", "Token");
      context.runtimeConfig.state.configSnapshot = null as never;
      for (const listener of configListeners) {
        listener();
      }
      expect(fields.read(path)).toBe("abc");
    });
  });
});
