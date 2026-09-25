// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { setAvatarGatewayOrigin } from "../identity-avatar-context.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

const originalRaw = '{ "tools": { "exec": { "node": "original" } } }\n';
const nodePath = ["tools", "exec", "node"];
const nodeConfig = (node: string) => ({ tools: { exec: { node } } });
const rawForNode = (node: string) => `${JSON.stringify(nodeConfig(node), null, 2)}\n`;

function createRecoveryHarness(
  outcome: "own" | "uncommitted" | "foreign" = "own",
  initialRaw = originalRaw,
  writeMethod: "config.set" | "config.apply" = "config.set",
) {
  let storedRaw = initialRaw;
  let hash = "before";
  let getCount = 0;
  const firstAck = deferred<unknown>();
  let firstApply: Promise<boolean> | undefined;
  const recoveryRead = deferred();
  const submissions: Array<{ raw: string; baseHash: string }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      const config = JSON.parse(storedRaw) as Record<string, unknown>;
      const snapshot = {
        config,
        sourceConfig: config,
        raw: storedRaw,
        hash,
        configRevisionHash: hash,
        appliedConfigHash: "before",
        valid: true,
        issues: [],
      };
      if (++getCount === 2) {
        await recoveryRead.promise;
      }
      return snapshot;
    }
    if (method !== "config.set" && method !== "config.apply") {
      return {};
    }
    const submission = params as { raw: string; baseHash: string };
    submissions.push(submission);
    if (submission.baseHash !== hash) {
      throw new Error("config changed since last load; re-run config.get and retry");
    }
    if (submissions.length === 1) {
      if (outcome !== "uncommitted") {
        storedRaw = submission.raw;
        hash = "own-commit";
      }
      return firstAck.promise;
    }
    storedRaw = submission.raw;
    hash = "explicit-save";
    return { config: JSON.parse(storedRaw), hash };
  });
  const { runtimeConfig, publish } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  return {
    runtimeConfig,
    submissions,
    get storedRaw() {
      return storedRaw;
    },
    async start(edit = () => runtimeConfig.patchForm(nodePath, "submitted")) {
      await runtimeConfig.ensureLoaded();
      edit();
      firstApply = writeMethod === "config.apply" ? runtimeConfig.apply() : undefined;
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.baseHash).toBe("before");
    },
    async reconnect(duringLoad?: () => void) {
      if (outcome === "foreign") {
        storedRaw = rawForNode("foreign");
        hash = "foreign";
      }
      // The transport rejects pending requests before publishing socket close.
      firstAck.reject(new Error("socket closed"));
      publish(false);
      publish(true);
      expect(getCount).toBe(2);
      expect(runtimeConfig.state.configLoading).toBe(true);
      duringLoad?.();
      recoveryRead.resolve();
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      if (firstApply) {
        await expect(firstApply).resolves.toBe(false);
      }
      expect(runtimeConfig.state.configLoading).toBe(false);
      expect(submissions).toHaveLength(1);
    },
    dispose() {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
      recoveryRead.resolve();
      firstAck.resolve({});
    },
  };
}

describe("config write recovery", () => {
  it.each([
    ["save", false],
    ["apply", false],
    ["save", true],
    ["apply", true],
  ] as const)(
    "keeps unsettled %s retry on its originating Gateway (same target: %s)",
    async (operation, sameTarget) => {
      vi.useFakeTimers();
      stubGatewayStoreTestGlobals();
      const store = createGatewayStoreTestStore();
      const serverA = createConfigServerMock();
      const serverB = sameTarget ? serverA : createConfigServerMock();
      const hello = gatewayHelloForMethods([
        "config.schema",
        "config.set",
        "config.apply",
        "config.patch",
      ]);
      const runtimeConfig = createRuntimeConfigCapability(store.gateway);
      try {
        store.gateway.start();
        const originalUrl = store.current().gatewayUrl;
        store.current().request.mockImplementation(async (method, params) => {
          if (method === "config.set" || method === "config.apply") {
            throw new Error("Request timed out");
          }
          return serverA.request(method, params);
        });
        store.current().opts.onHello?.(hello);
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await expect(
          operation === "apply" ? runtimeConfig.apply() : runtimeConfig.save(),
        ).resolves.toBe(false);
        expect(runtimeConfig.state.lastError).toContain("Request timed out");

        store.gateway.connect({
          gatewayUrl: sameTarget
            ? `${originalUrl.replace(/\/+$/, "")}/`
            : "wss://other-gateway.example.test",
        });
        const replacement = store.current();
        replacement.request.mockImplementation((method, params) => serverB.request(method, params));
        replacement.opts.onHello?.(hello);
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
        expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
        const retried = await runtimeConfig.retry();
        const writes = replacement.request.mock.calls.filter(
          ([method]) => method === "config.set" || method === "config.apply",
        );
        expect.soft(writes).toHaveLength(sameTarget ? 1 : 0);
        expect(retried).toBe(sameTarget);
        if (sameTarget) {
          expect(writes[0]?.[0]).toBe(operation === "apply" ? "config.apply" : "config.set");
        }
        await expect(serverB.request("config.get")).resolves.toMatchObject({
          config: { count: sameTarget ? 2 : 1 },
        });
        if (!sameTarget) {
          expect(runtimeConfig.state.lastError).toContain("different Gateway");
          const originalDraftBase = runtimeConfig.state.configRawOriginal;
          // Matching content on another Gateway cannot confirm the original write.
          await serverB.request("config.apply", {
            raw: JSON.stringify({ count: 2 }, null, 2) + "\n",
            baseHash: "hash-1",
          });
          await runtimeConfig.refresh();
          expect(runtimeConfig.state.configRawOriginal).toBe(originalDraftBase);
          expect(canReloadControlUiDocument()).toBe(false);
          await expect(runtimeConfig.retry()).resolves.toBe(false);
          expect(
            replacement.request.mock.calls.filter(
              ([method]) => method === "config.set" || method === "config.apply",
            ),
          ).toHaveLength(0);
          if (operation === "save") {
            store.gateway.connect({ gatewayUrl: originalUrl });
            store
              .current()
              .request.mockImplementation((method, params) => serverA.request(method, params));
            store.current().opts.onHello?.(hello);
            await vi.advanceTimersByTimeAsync(0);
            await expect(runtimeConfig.retry()).resolves.toBe(true);
            expect(serverA.submissions).toMatchObject([{ method: "config.set" }]);
          } else {
            await runtimeConfig.discardDraft();
            expect(runtimeConfig.state.configFormDirty).toBe(false);
            expect(canReloadControlUiDocument()).toBe(true);
            runtimeConfig.patchForm(["count"], 3);
            await expect(runtimeConfig.save()).resolves.toBe(true);
            await expect(serverB.request("config.get")).resolves.toMatchObject({
              config: { count: 3 },
            });
          }
        }
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
        store.gateway.stop();
        await vi.dynamicImportSettled();
        setAvatarGatewayOrigin(null);
      }
    },
  );

  it("shows unresolved reconnect uncertainty and preserves a revert when the old write later commits", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const firstWrite = deferred<unknown>();
    let heldParams: unknown;
    let first = true;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.set" && first) {
        first = false;
        heldParams = params;
        return firstWrite.promise;
      }
      return server.request(method, params);
    });
    const { runtimeConfig, publish } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      runtimeConfig.patchForm(["count"], 1);
      firstWrite.reject(new Error("Request timed out"));
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(canReloadControlUiDocument()).toBe(false);
      publish(false);
      expect.soft(canReloadControlUiDocument()).toBe(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      expect.soft(canReloadControlUiDocument()).toBe(false);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
      expect(runtimeConfig.state.lastError).toContain("could not be confirmed");
      await expect(
        runtimeConfig.patch({ raw: { unrelated: true }, note: "synthetic toggle" }),
      ).resolves.toBe(false);
      expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      await server.request("config.set", heldParams);
      await runtimeConfig.refresh();
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(canReloadControlUiDocument()).toBe(true);
      expect(server.submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
        { count: 2 },
        { count: 1 },
      ]);
    } finally {
      runtimeConfig.setWritesSuspended(true);
      firstWrite.resolve({});
      runtimeConfig.dispose();
    }
  });

  it.each([false, true])(
    "retries the interrupted Apply operation (persisted: %s)",
    async (persisted) => {
      vi.useFakeTimers();
      const server = createConfigServerMock();
      let failApply = true;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.apply" && failApply) {
          failApply = false;
          if (persisted) {
            await server.request("config.set", params);
          }
          throw new Error("Apply outcome is unknown");
        }
        return server.request(method, params);
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        await expect(runtimeConfig.apply()).resolves.toBe(false);
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
        await expect(runtimeConfig.retry()).resolves.toBe(true);
        expect(
          request.mock.calls
            .filter(([method]) => method === "config.apply" || method === "config.set")
            .map(([method]) => method),
        ).toEqual(["config.apply", "config.apply"]);
        expect(runtimeConfig.state.configNeedsApply).toBe(false);
        expect(runtimeConfig.state.lastError).toBeNull();
        expect(canReloadControlUiDocument()).toBe(true);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
      }
    },
  );

  it("reconciles the bytes dispatched after original-config parsing settles", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    const { runtimeConfig, submissions } = harness;
    const parsing = deferred();
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.state.configRawOriginalParsePending = parsing.promise;
      runtimeConfig.patchForm(nodePath, "before-parse");
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(submissions).toHaveLength(0);

      runtimeConfig.patchForm(nodePath, "dispatched");
      parsing.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(submissions).toEqual([{ raw: rawForNode("dispatched"), baseHash: "before" }]);

      runtimeConfig.patchForm(nodePath, "newer");
      await harness.reconnect();
      expect(runtimeConfig.state.configDraftBaseHash).toBe("own-commit");
      expect(runtimeConfig.state.configForm).toEqual(nodeConfig("newer"));
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(submissions[1]).toEqual({ raw: rawForNode("newer"), baseHash: "own-commit" });
    } finally {
      parsing.resolve();
      harness.dispose();
    }
  });

  it("retains pending plugin allowlist ownership without removing authored entries", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness(
      "own",
      JSON.stringify({ plugins: { allow: ["authored"], entries: {} } }),
    );
    const { runtimeConfig, submissions } = harness;
    try {
      await harness.start(() =>
        runtimeConfig.patchForm(["plugins", "entries", "first", "enabled"], true),
      );
      runtimeConfig.patchForm(["plugins", "entries", "pending", "enabled"], true);
      await harness.reconnect();
      runtimeConfig.patchForm(["plugins", "entries", "pending", "enabled"], false);
      runtimeConfig.patchForm(["plugins", "entries", "authored", "enabled"], false);
      expect(runtimeConfig.state.configForm?.plugins).toEqual({
        allow: ["authored", "first"],
        entries: {
          first: { enabled: true },
          pending: { enabled: false },
          authored: { enabled: false },
        },
      });
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(submissions).toHaveLength(1);
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(JSON.parse(harness.storedRaw).plugins.allow).toEqual(["authored", "first"]);
      expect(submissions[1]?.baseHash).toBe("own-commit");
    } finally {
      harness.dispose();
    }
  });

  it.each([
    { mode: "raw", edit: "revert", next: "raw" },
    { mode: "form", edit: "revert", next: "form" },
    { mode: "raw", edit: "newer", next: "raw" },
    { mode: "form", edit: "newer", next: "form" },
    { mode: "raw", edit: "revert", next: "form" },
    { mode: "raw", edit: "newer", next: "form" },
  ] as const)(
    "retains a $mode $edit before a subsequent $next edit",
    async ({ mode, edit, next }) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness();
      const { runtimeConfig, submissions } = harness;
      try {
        await harness.start();
        const node = edit === "revert" ? "original" : "newer";
        const pendingRaw = edit === "revert" ? originalRaw : `${rawForNode(node)}\n`;
        if (mode === "raw") {
          runtimeConfig.setRaw(pendingRaw);
        } else {
          runtimeConfig.patchForm(nodePath, node);
        }
        expect(runtimeConfig.state.configFormDirty).toBe(edit !== "revert");

        await harness.reconnect();
        expect(runtimeConfig.state.configFormMode).toBe(mode);
        expect(JSON.parse(runtimeConfig.state.configRaw)).toEqual(nodeConfig(node));
        if (mode === "raw") {
          expect(runtimeConfig.state.configRaw).toBe(pendingRaw);
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
        } else {
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        }
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configRawOriginal).toBe(rawForNode("submitted"));
        expect(runtimeConfig.state.configFormOriginal).toEqual(nodeConfig("submitted"));
        expect(runtimeConfig.state.configDraftBaseHash).toBe("own-commit");
        expect(runtimeConfig.state.configNeedsApply).toBe(true);

        // The pre-write document is now a real edit, not a clean revert to stale originals.
        if (next === "raw") {
          runtimeConfig.setRaw(originalRaw);
        } else {
          if (mode === "raw") {
            runtimeConfig.setRaw(`${pendingRaw}\n`);
          }
          runtimeConfig.patchForm(nodePath, "original");
        }
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(next === "form" ? "paused" : "idle");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(submissions).toHaveLength(1);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(submissions[1]).toEqual({
          raw: next === "raw" ? originalRaw : rawForNode("original"),
          baseHash: "own-commit",
        });
        expect(JSON.parse(harness.storedRaw)).toEqual(nodeConfig("original"));
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
      } finally {
        harness.dispose();
      }
    },
  );

  it.each([false, true])(
    "keeps a raw-first draft paused after reconnect (rejected form edit: %s)",
    async (rejectFormEdit) => {
      vi.useFakeTimers();
      const server = createConfigServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        server.request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.setRaw('{"count":2}');
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
        expect(server.submissions).toHaveLength(0);
        if (rejectFormEdit) {
          runtimeConfig.setRaw("{");
          runtimeConfig.patchForm(["count"], 3);
          expect(runtimeConfig.state.configFormMode).toBe("raw");
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
          expect(runtimeConfig.state.configRaw).toBe("{");
        }
        runtimeConfig.setRaw('{"count":2}\n');
        runtimeConfig.patchForm(["count"], 3);
        expect.soft(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(server.submissions).toHaveLength(0);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(server.submissions).toEqual([
          { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
        ]);
        runtimeConfig.patchForm(["count"], 4);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(server.submissions[1]).toEqual({
          method: "config.set",
          raw: '{\n  "count": 4\n}\n',
          baseHash: "hash-2",
        });
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
      }
    },
  );

  it("retains a Devices binding reverted while the recovery read is pending", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    const { runtimeConfig, submissions } = harness;
    try {
      await harness.start();
      runtimeConfig.patchForm(nodePath, "newer");
      await harness.reconnect(() => {
        // Devices binding controls remain enabled while config.get is loading.
        expect(runtimeConfig.canSet).toBe(true);
        expect(runtimeConfig.state.configSaving).toBe(false);
        runtimeConfig.patchForm(nodePath, "original");
        expect(runtimeConfig.state.configFormDirty).toBe(false);
      });
      expect(runtimeConfig.state.configForm).toEqual(nodeConfig("original"));
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
      expect(runtimeConfig.state.configRawOriginal).toBe(rawForNode("submitted"));
      expect(runtimeConfig.state.configDraftBaseHash).toBe("own-commit");
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(submissions[1]).toEqual({ raw: rawForNode("original"), baseHash: "own-commit" });
      expect(JSON.parse(harness.storedRaw)).toEqual(nodeConfig("original"));
    } finally {
      harness.dispose();
    }
  });

  it.each([
    { mode: "raw", method: "config.set" },
    { mode: "form", method: "config.set" },
    { mode: "raw", method: "config.apply" },
    { mode: "form", method: "config.apply" },
  ] as const)(
    "reports a foreign write before retrying a $mode draft interrupted during $method",
    async ({ mode, method }) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness("foreign", originalRaw, method);
      const { runtimeConfig } = harness;
      try {
        await harness.start();
        if (mode === "raw") {
          runtimeConfig.setRaw(`${rawForNode("newer")}\n`);
        } else {
          runtimeConfig.patchForm(nodePath, "newer");
        }
        await harness.reconnect();
        expect(runtimeConfig.state.configDraftBaseHash).toBe("before");
        expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
        expect(JSON.parse(runtimeConfig.state.configRaw)).toEqual(nodeConfig("newer"));
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
        expect(runtimeConfig.state.lastError).toContain("config changed since last load");
        await expect(runtimeConfig.save()).resolves.toBe(false);
        expect(harness.storedRaw).toBe(rawForNode("foreign"));
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      } finally {
        harness.dispose();
      }
    },
  );

  it.each(["own", "uncommitted"] as const)(
    "leaves a matching %s document clean",
    async (outcome) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness(outcome);
      const { runtimeConfig } = harness;
      try {
        await harness.start();
        if (outcome === "uncommitted") {
          runtimeConfig.setRaw(originalRaw);
        }
        await harness.reconnect();
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configRaw).toBe(harness.storedRaw);
        expect(runtimeConfig.state.configRawOriginal).toBe(harness.storedRaw);
        expect(runtimeConfig.state.configDraftBaseHash).toBe(
          outcome === "own" ? "own-commit" : "before",
        );
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(outcome === "own" ? "idle" : "error");
        if (outcome === "uncommitted") {
          expect(runtimeConfig.state.lastError).toContain("could not be confirmed");
        }
      } finally {
        harness.dispose();
      }
    },
  );
});
