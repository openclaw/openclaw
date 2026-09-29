// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "./config-test-harness.ts";

it.each(["Settings", "external"])(
  "%s config.set retains publication recovery through queued writes, Raw errors and reads",
  async (origin) => {
    vi.useFakeTimers();
    const firstWrite = deferred<unknown>();
    const server = createConfigServerMock();
    let readState = "valid";
    let recovered = false;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set" && !recovered) {
        return firstWrite.promise;
      }
      if (method === "config.get") {
        if (readState === "failed") {
          throw new Error("read unavailable");
        }
        return readState === "missing"
          ? { exists: false, valid: true, config: {}, raw: null, hash: "missing" }
          : { ...(await server.request(method, params)), exists: true };
      }
      if (method === "config.schema") {
        throw new Error("schema unavailable");
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const original = runtimeConfig.state.configRaw;
    if (origin === "Settings") {
      runtimeConfig.patchForm(["count"], 2);
    }
    const externalWrite = () =>
      runtimeConfig.runExternalMutation((client) =>
        client.request("config.set", { raw: '{"count":3}', baseHash: "hash-1" }),
      );
    const failedWrite = origin === "Settings" ? runtimeConfig.save() : externalWrite();
    const queuedWrite = externalWrite();
    firstWrite.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "included config changed since last load",
        details: {
          publication: "partial",
          rollbackStatus: "unknown",
          configPath: "/settings/openclaw.json",
          recoveryBackupPath: "/settings/openclaw.json.bak",
        },
      }),
    );
    await failedWrite;
    const recovery = runtimeConfig.state.configRecoveryError;
    expect(recovery).toContain("/settings/openclaw.json.bak");
    await expect(queuedWrite).resolves.toMatchObject({ ok: false, error: recovery });
    await expect(externalWrite()).resolves.toMatchObject({ ok: false, error: recovery });

    runtimeConfig.setRaw('{"count":42}');
    const discard = runtimeConfig.discardDraft();
    publish(false);
    await discard;
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configRaw).toBe('{"count":42}');
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configRecoveryError).toBe(recovery);
    await expect(externalWrite()).resolves.toMatchObject({
      ok: false,
      error: "Connection changed before the configuration update started.",
    });
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    readState = "failed";
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configRaw).toBe('{"count":42}');
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    runtimeConfig.setRaw("{");
    runtimeConfig.patchForm(["count"], 4);
    runtimeConfig.setRaw(original);
    await runtimeConfig.refresh();
    readState = "failed";
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    await runtimeConfig.refreshSchema();
    await runtimeConfig.openFile();
    readState = "missing";
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configRecoveryError).toBe(recovery);
    expect(runtimeConfig.state.configRaw).toBe(original);

    runtimeConfig.patchForm(["count"], 4);
    await runtimeConfig.save();
    await runtimeConfig.apply();
    await runtimeConfig.patch({ raw: { count: 4 }, note: "test" });
    await expect(externalWrite()).resolves.toMatchObject({ ok: false, error: recovery });
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
    expect(
      request.mock.calls.some(([method]) => method === "config.patch" || method === "config.apply"),
    ).toBe(false);

    readState = "valid";
    recovered = true;
    await runtimeConfig.discardDraft();
    expect(runtimeConfig.state.configRecoveryError).toBeNull();
    runtimeConfig.patchForm(["count"], 5);
    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(server.submissions).toHaveLength(1);
    expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([{ count: 5 }]);
    runtimeConfig.dispose();
  },
);
