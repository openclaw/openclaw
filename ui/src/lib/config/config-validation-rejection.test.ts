// @vitest-environment node

import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  expectFeedback,
  configServerTransport,
  loadedConfig,
} from "./config-suite.test-support.ts";
import { createConfigServerMock } from "./config-test-harness.ts";

const issues = [{ path: "count", message: "Expected number, received string" }];
const rejectionMessage = "invalid config: count: Expected number, received string";
const persisted = { issues, persistedConfig: { config: { count: 2 }, hash: "hash-2" } };
const partial = { issues, publication: "partial", rollbackStatus: "restored" };
const complete = { issues, publication: "complete", rollbackStatus: "unknown" };
beforeEach(() => vi.useFakeTimers());

async function validationError(
  overrides: ConstructorParameters<typeof GatewayRequestError>[0] = {
    code: "INVALID_REQUEST",
    message: rejectionMessage,
    details: { issues },
  },
) {
  const transport = configServerTransport(
    async () => ({ ok: false, error: overrides }),
    () => "validation-rejection",
  );
  transport.start();
  const error = await transport.request("config.set").catch((rejection: unknown) => rejection);
  transport.stop();
  expect(error).toBeInstanceOf(GatewayRequestError);
  return error;
}

async function validationEditor(
  failure = validationError,
  intercept: (method: string) => Promise<unknown> | undefined = () => undefined,
  methods = ["config.set"],
) {
  const server = createConfigServerMock();
  const writes = { rejected: true };
  const request = vi.fn(async (method: string, params?: unknown) => {
    const result = intercept(method);
    if (result) {
      return result;
    }
    if (methods.includes(method) && writes.rejected) {
      throw await failure();
    }
    return server.request(method === "config.patch" ? "config.set" : method, params);
  });
  return { ...(await loadedConfig(request, true)), server, writes };
}

it.each(["save", "apply", "patch"] as const)(
  "%s retains rejected settings and accepts a correction on the unchanged revision",
  async (operation) => {
    const { runtimeConfig, state, server, writes } = await validationEditor(
      validationError,
      undefined,
      ["config.set", "config.apply", "config.patch"],
    );
    const original = state.configSnapshot;
    if (operation !== "patch") {
      runtimeConfig.patchForm(["count"], "invalid");
    }
    const submit = () =>
      operation === "patch"
        ? runtimeConfig.patch({
            raw: { count: writes.rejected ? "invalid" : 2 },
            note: "change count",
          })
        : runtimeConfig[operation]();

    await expect(submit()).resolves.toBe(false);
    expectFeedback(state, "rejected", expect.stringContaining("count: Expected number"));
    expect(state.configSnapshot).toEqual(original);
    expect(state.configForm).toEqual({
      count: operation === "patch" ? 1 : "invalid",
    });
    expect(state.configRecoveryError).toBeNull();

    writes.rejected = false;
    if (operation !== "patch") {
      runtimeConfig.patchForm(["count"], 2);
      expect(state.lastError).toBeNull();
    }
    await expect(submit()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      {
        method: operation === "apply" ? "config.apply" : "config.set",
        raw: expect.any(String),
        baseHash: "hash-1",
      },
    ]);
    expect(state.configForm).toEqual({ count: 2 });
    expect(state).toMatchObject({ configFormDirty: false, lastError: null });
  },
);

it.each(["unchanged", "saved"] as const)(
  "preserves current %s draft feedback when opening the saved file succeeds",
  async (outcome) => {
    const opened = deferred<{ ok: boolean }>();
    const { runtimeConfig, state, server, writes } = await validationEditor(
      validationError,
      (method) => (method === "config.openFile" ? opened.promise : undefined),
    );
    runtimeConfig.setRaw('{"count":"invalid"}');
    await expect(runtimeConfig.save()).resolves.toBe(false);
    let opening: Promise<void> | undefined;
    try {
      expect(state.lastError).toContain("Expected number");
      opening = runtimeConfig.openFile();
      expectFeedback(state, "rejected", expect.stringContaining("Expected number"));

      if (outcome !== "unchanged") {
        writes.rejected = false;
        runtimeConfig.setRaw('{"count":2}');
        await expect(runtimeConfig.save()).resolves.toBe(true);
      }
      opened.resolve({ ok: true });
      await opening;

      expect(state.configAutoSaveStatus).toBe(outcome === "unchanged" ? "rejected" : "saved");
      if (outcome === "unchanged") {
        expect(state).toMatchObject({
          lastError: expect.stringContaining("Expected number"),
          configRaw: '{"count":"invalid"}',
        });
      } else {
        expect(state.lastError).toBeNull();
        expect(JSON.parse(state.configRaw)).toEqual({ count: 2 });
      }
      expect(state.configFormDirty).toBe(outcome !== "saved");
      expect(server.submissions).toHaveLength(outcome === "saved" ? 1 : 0);
      expect(state.configSnapshot?.hash).toBe(outcome === "saved" ? "hash-2" : "hash-1");
    } finally {
      opened.resolve({ ok: true });
      await opening;
    }
  },
);

it.each([
  ["permission", "FORBIDDEN", "permission denied", { issues }, "error"],
  ["conflict", "INVALID_REQUEST", "config changed since last load", { issues }, "conflict"],
  ["request shape", "INVALID_REQUEST", "raw required", undefined, "error"],
  ["malformed issues", "INVALID_REQUEST", "invalid config", { issues: [{}] }, "error"],
  ["transport", "UNAVAILABLE", "connection closed", { issues }, "error"],
  ["partial publication", "INVALID_REQUEST", "publication failed", partial, "error"],
  ["complete publication", "INVALID_REQUEST", "publication failed", complete, "error"],
  ["persisted write", "INVALID_REQUEST", "runtime apply failed", persisted, "error"],
  ["uncertain retry", "INVALID_REQUEST", rejectionMessage, { issues }, "error", true],
] as const)(
  "keeps %s failures out of the validation notice",
  async (_label, code, message, details, status, previousUncertain?: boolean) => {
    let writes = 0;
    const { runtimeConfig, state } = await validationEditor(async () => {
      if (previousUncertain && ++writes === 1) {
        throw new Error("connection closed after dispatch");
      }
      return validationError({ code, message, details });
    });
    runtimeConfig.patchForm(["count"], 2);
    await expect(runtimeConfig.save()).resolves.toBe(false);
    if (previousUncertain) {
      await expect(runtimeConfig.retry()).resolves.toBe(false);
      await runtimeConfig.waitForPendingWrites();
      expect(state).toMatchObject({
        lastError: expect.stringContaining("could not be confirmed"),
        configFormDirty: true,
      });
    }
    expect(state.configAutoSaveStatus).toBe(status);
  },
);

it.each(["refresh", "ensureSchemaLoaded", "openFile"] as const)(
  "replaces a validation notice when a later %s fails",
  async (operation) => {
    let failedRead = false;
    const { runtimeConfig, state } = await validationEditor(validationError, (method) =>
      failedRead && method !== "config.set"
        ? Promise.reject(new Error("connection closed"))
        : undefined,
    );
    runtimeConfig.patchForm(["count"], "invalid");
    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(state.configAutoSaveStatus).toBe("rejected");
    await runtimeConfig.refresh({ background: true });
    expect(state.lastError).toContain("Expected number");
    await runtimeConfig.refresh();
    expectFeedback(state, "rejected", expect.stringContaining("Expected number"));
    failedRead = true;
    await runtimeConfig[operation]();
    expectFeedback(state, "error", "connection closed");
  },
);
