// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { REDACTED_SENTINEL } from "../config-form-utils.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
} from "./config-test-harness.ts";

function rejectedEdit() {
  const server = createConfigServerMock();
  let reject = true;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.set" && reject) {
      reject = false;
      throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" });
    }
    return server.request(method, params);
  });
  return {
    server,
    request,
    ...createConfigCapabilityHarness(request as GatewayBrowserClient["request"]),
  };
}

describe("field-scoped config draft cancellation", () => {
  it("discards a rejected field without losing an unrelated edit or resubmitting canceled bytes", async () => {
    vi.useFakeTimers();
    const { runtimeConfig, server } = rejectedEdit();
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await expect(runtimeConfig.flushFormChanges()).resolves.toBe(false);
    runtimeConfig.patchForm(["other"], "retained");
    await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(true);
    expect(runtimeConfig.state.configForm).toEqual({ count: 1, other: "retained" });
    await expect(runtimeConfig.flushFormChanges()).resolves.toBe(true);
    expect(server.submissions.map((entry) => JSON.parse(entry.raw))).toEqual([
      { count: 1, other: "retained" },
    ]);
    runtimeConfig.dispose();
  });

  it.each(["absent", "authored-empty", "sibling"])(
    "restores %s ancestor containers without creating a new write on Cancel",
    async (scenario) => {
      vi.useFakeTimers();
      const saved = {
        plugins: {
          entries: {
            demo: {
              enabled: true,
              ...(scenario === "authored-empty" ? { config: { search: {} } } : {}),
            },
          },
        },
      };
      const request = vi.fn(async (method: string) => {
        if (method === "config.get") {
          return { config: saved, raw: JSON.stringify(saved), hash: "saved", valid: true };
        }
        if (method === "config.set") {
          throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" });
        }
        return {};
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      const parent = ["plugins", "entries", "demo", "config", "search"];
      runtimeConfig.patchForm([...parent, "apiKey"], {
        source: "file",
        provider: "team",
        id: "/new-key",
      });
      await runtimeConfig.flushFormChanges();
      if (scenario === "sibling") {
        runtimeConfig.patchForm([...parent, "mode"], "web");
      }
      await expect(runtimeConfig.discardFormValue([...parent, "apiKey"])).resolves.toBe(true);
      expect(runtimeConfig.state.configForm).toEqual(
        scenario === "sibling"
          ? {
              plugins: {
                entries: { demo: { enabled: true, config: { search: { mode: "web" } } } },
              },
            }
          : saved,
      );
      expect(runtimeConfig.state.configFormDirty).toBe(scenario === "sibling");
      if (scenario === "sibling") {
        runtimeConfig.setWritesSuspended(true);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      runtimeConfig.dispose();
    },
  );

  it("waits for a pending acknowledgement and preserves its committed value", async () => {
    vi.useFakeTimers();
    const server = createDeferredSetServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    const save = runtimeConfig.flushFormChanges();
    const cancel = runtimeConfig.discardFormValue(["count"]);
    server.firstSet.resolve({});
    await save;
    await expect(cancel).resolves.toBe(true);
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(server.submissions).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it.each(["field", "same-value", "sibling", "raw", "connection"])(
    "does not let a delayed cancellation replace newer %s intent",
    async (change) => {
      vi.useFakeTimers();
      const { runtimeConfig, request, server, publish } = rejectedEdit();
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await runtimeConfig.flushFormChanges();
      const snapshot = await server.request("config.get");
      const read = createDeferred<typeof snapshot>();
      request.mockImplementationOnce(() => read.promise);
      const cancel = runtimeConfig.discardFormValue(["count"]);
      if (change === "field" || change === "same-value") {
        runtimeConfig.patchForm(["count"], change === "field" ? 3 : 2);
      } else if (change === "sibling") {
        runtimeConfig.patchForm(["other"], "new edit");
      } else if (change === "raw") {
        runtimeConfig.setRaw('{"count":3}');
      } else {
        publish(false);
      }
      read.resolve(snapshot);
      await expect(cancel).resolves.toBe(change === "sibling");
      if (change === "sibling") {
        expect(runtimeConfig.state.configForm).toEqual({ count: 1, other: "new edit" });
      } else if (change === "raw") {
        expect(runtimeConfig.state.configRaw).toBe('{"count":3}');
      } else {
        expect(runtimeConfig.state.configForm).toEqual({ count: change === "field" ? 3 : 2 });
      }
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
    },
  );

  it.each(["uncommitted", "exact", "redacted"])(
    "reconciles an unknown write only when the saved bytes confirm it (%s)",
    async (outcome) => {
      const committed = outcome !== "uncommitted";
      const confirmed = outcome === "exact";
      vi.useFakeTimers();
      const server = createConfigServerMock();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.set") {
          if (committed) {
            await server.request(method, params);
          }
          throw new Error("Transport acknowledgement unavailable");
        }
        const result = await server.request(method, params);
        if (method === "config.get" && outcome === "redacted" && server.submissions.length > 0) {
          const config = { count: { source: "file", provider: "team", id: REDACTED_SENTINEL } };
          return { ...result, config, raw: JSON.stringify(config) };
        }
        return result;
      });
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      const value =
        outcome === "redacted" ? { source: "file", provider: "team", id: "/new-key" } : 2;
      runtimeConfig.patchForm(["count"], value);
      await runtimeConfig.flushFormChanges();
      await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(confirmed);
      expect(runtimeConfig.state.configForm).toEqual({ count: value });
      expect(runtimeConfig.state.configFormDirty).toBe(!confirmed);
      expect(runtimeConfig.state.configRecoveryError === null).toBe(confirmed);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      runtimeConfig.dispose();
    },
  );

  it("keeps the rejected draft and error visible when the authoritative read fails", async () => {
    vi.useFakeTimers();
    const { runtimeConfig, request } = rejectedEdit();
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await runtimeConfig.flushFormChanges();
    request.mockRejectedValueOnce(new Error("Config read unavailable"));
    await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(false);
    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.lastError).toContain("Config read unavailable");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
    runtimeConfig.setWritesSuspended(true);
    runtimeConfig.dispose();
  });
});
