// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { expectCalls, loadedConfig } from "./config-suite.test-support.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
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
      if (method === "config.schema" || (method === "config.get" && readState === "failed")) {
        throw new Error("read unavailable");
      }
      if (method === "config.get") {
        return readState === "missing"
          ? { exists: false, valid: true }
          : { ...(await server.request(method, params)), exists: true };
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish, state } = await loadedConfig(request);
    const original = state.configRaw;
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
    const recovery = state.configRecoveryError;
    expect(recovery).toContain("/settings/openclaw.json.bak");
    await expect(queuedWrite).resolves.toMatchObject({ ok: false, error: recovery });
    await expect(externalWrite()).resolves.toMatchObject({ ok: false, error: recovery });

    const draft = { configRaw: '{"count":42}', configFormDirty: true };
    runtimeConfig.setRaw(draft.configRaw);
    const discard = runtimeConfig.discardDraft();
    publish(false);
    await discard;
    await runtimeConfig.discardDraft();
    expect(state).toMatchObject({ ...draft, configRecoveryError: recovery });
    await expect(externalWrite()).resolves.toMatchObject({
      ok: false,
      error: "Connection changed before the configuration update started.",
    });
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    readState = "failed";
    await runtimeConfig.discardDraft();
    expect(state).toMatchObject(draft);

    runtimeConfig.setRaw("{");
    runtimeConfig.patchForm(["count"], 4);
    runtimeConfig.setRaw(original);
    await runtimeConfig.refresh();
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    await runtimeConfig.refreshSchema();
    await runtimeConfig.openFile();
    readState = "missing";
    await runtimeConfig.discardDraft();
    expect(state).toMatchObject({ configRecoveryError: recovery, configRaw: original });

    runtimeConfig.patchForm(["count"], 4);
    await runtimeConfig.save();
    await runtimeConfig.apply();
    await runtimeConfig.patch({ raw: { count: 4 }, note: "test" });
    await expect(externalWrite()).resolves.toMatchObject({ ok: false, error: recovery });
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expectCalls(request, "config.set", 1);
    expectCalls(request, "config.patch", 0);
    expectCalls(request, "config.apply", 0);

    readState = "valid";
    recovered = true;
    await runtimeConfig.discardDraft();
    expect(state.configRecoveryError).toBeNull();
    runtimeConfig.patchForm(["count"], 5);
    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([{ count: 5 }]);
  },
);
