/* @vitest-environment jsdom */

import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { createShellConfig } from "./app-shell-gateway.test-support.ts";

afterEach(() => vi.useRealTimers());

it.each([
  { revert: false, refresh: "event" },
  { revert: true, refresh: "event" },
  { revert: false, refresh: "reconnect" },
  { revert: true, refresh: "reconnect" },
] as const)(
  "keeps a correlated apply failure across $refresh (mid-apply revert: $revert)",
  async ({ revert, refresh }) => {
    vi.useFakeTimers();
    let storedRaw = '{\n  "count": 1\n}\n';
    let revision = 1;
    let appliedRevision = 1;
    let rejectApply: () => void = () => {
      throw new Error("apply request missing");
    };
    const protocol = new GatewayProtocolClient<Record<string, never>>({
      createRequestId: () => "synthetic-request",
      createSocket: (handlers) => {
        void Promise.resolve().then(() => {
          handlers.open();
          handlers.message(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "fixture" },
            }),
          );
        });
        return {
          isOpen: () => true,
          close: () => handlers.close(1000, ""),
          send: (data) => {
            const frame = JSON.parse(data) as {
              id: string;
              method: string;
              params: { raw?: string };
            };
            if (frame.method === "config.apply") {
              storedRaw = frame.params.raw ?? storedRaw;
              revision++;
              rejectApply = () =>
                handlers.message(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                    error: {
                      code: "UNAVAILABLE",
                      message: "config.apply persisted but was not applied to the active Gateway",
                    },
                  }),
                );
            } else {
              handlers.message(
                JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: true,
                  payload:
                    frame.method === "connect"
                      ? { type: "hello-ok" }
                      : {
                          config: JSON.parse(storedRaw),
                          raw: storedRaw,
                          hash: `hash-${revision}`,
                          configRevisionHash: `revision-${revision}`,
                          appliedConfigHash: `revision-${appliedRevision}`,
                          valid: true,
                          issues: [],
                        },
                }),
              );
            }
          },
        };
      },
      createRequestError: (error) =>
        new GatewayRequestError({
          code: error.code ?? "UNAVAILABLE",
          message: error.message ?? "request failed",
          details: error.details,
          retryable: error.retryable,
          retryAfterMs: error.retryAfterMs,
        }),
      buildConnectPlan: () => ({}),
      buildConnectParams: (plan) => plan,
      resolveClose: () => ({ retry: false, notify: false }),
      handshake: { mode: "require-challenge", timeoutMs: 100 },
      reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    });
    protocol.start();
    const { runtimeConfig, publish, owner } = createShellConfig(protocol.request.bind(protocol));
    try {
      await runtimeConfig.ensureLoaded();
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      if (revert) {
        runtimeConfig.patchForm(["count"], 2);
      }
      const applied = runtimeConfig.apply();
      if (revert) {
        runtimeConfig.patchForm(["count"], 1);
      }
      owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
      await vi.advanceTimersByTimeAsync(0);
      rejectApply();
      await expect(applied).resolves.toBe(false);
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      expect(runtimeConfig.state.lastError).toContain("was not applied");
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
      if (refresh === "reconnect") {
        publish(false);
        publish(true);
      } else {
        owner.handleGatewayEvent({ type: "event", event: "config.changed", payload: {} });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
      expect(runtimeConfig.state.lastError).toContain("was not applied");
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
      expect(runtimeConfig.state.configNeedsApply).toBe(true);
      if (!revert) {
        appliedRevision = revision;
        await runtimeConfig.refresh();
        expect(runtimeConfig.state.configNeedsApply).toBe(false);
        expect(runtimeConfig.state.lastError).toBeNull();
      }
    } finally {
      runtimeConfig.setWritesSuspended(true);
      owner.dispose();
      runtimeConfig.dispose();
      protocol.stop();
    }
  },
);
