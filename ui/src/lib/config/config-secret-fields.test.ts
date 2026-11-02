import { describe, expect, it, vi } from "vitest";
import { configSecretFields } from "./config-secret-fields.ts";

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
});
