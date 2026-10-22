import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DebugProxySettings } from "./env.js";
import * as capture from "./runtime.js";
import {
  listDebugProxyCaptureSessions,
  readDebugProxyCaptureSessionEvents,
} from "./store-readonly.js";
import { getDebugProxyCaptureStore } from "./store.sqlite.js";

export function registerMixedCaptureLifecycleTests(options: {
  stateRoot: () => string;
  captureSettings: (root: string, sessionId: string) => DebugProxySettings;
  pendingResponse: (chunks: Buffer[]) => {
    response: Response;
    controller: ReadableStreamDefaultController<Uint8Array>;
    pending: Promise<void>;
  };
}): void {
  const { stateRoot, captureSettings, pendingResponse } = options;
  it.each(["legacy-first", "async-first"])("separates legacy from host (%s)", async (order) => {
    const root = stateRoot();
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const settings = captureSettings(root, "mixed-lifecycle");
    const fetchTarget: typeof globalThis = {
      ...globalThis,
      fetch: vi.fn(async () => new Response("host")),
    };
    const deps = { fetchTarget };
    const frame = (payload: string) => ({
      url: "wss://example.test",
      kind: "ws-frame" as const,
      direction: "outbound" as const,
      flowId: payload,
      payload,
    });
    const legacy = pendingResponse([Buffer.from("legacy prefix")]);
    const host = pendingResponse([Buffer.from("host prefix")]);
    let hostWriting: Promise<void> | undefined;
    try {
      if (order === "legacy-first") {
        capture.initializeDebugProxyCapture("legacy-plugin", settings, deps);
      }
      await capture.initializeDebugProxyCaptureAsync("host", settings, deps);
      if (order === "async-first") {
        capture.initializeDebugProxyCapture("legacy-plugin", settings, deps);
      }
      const store = getDebugProxyCaptureStore();
      capture.captureHttpExchange(
        { url: "https://example.test/legacy", method: "GET", response: legacy.response },
        settings,
        deps,
      );
      hostWriting = capture.captureHttpExchangeAsync(
        { url: "https://example.test/host", method: "GET", response: host.response },
        settings,
        deps,
      );
      await Promise.all([legacy.pending, host.pending]);
      expect(() => capture.finalizeDebugProxyCapture(settings, deps)).not.toThrow();
      expect(store.isClosed).toBe(true);
      capture.captureWsEvent(frame("late legacy"), settings, deps);
      await fetchTarget.fetch("https://example.test/after-legacy");
      await capture.captureWsEventAsync(frame("host still active"), settings, deps);
      const read = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => ({
            session: listDebugProxyCaptureSessions(db).find(({ id }) => id === settings.sessionId),
            rows: readDebugProxyCaptureSessionEvents(db, settings.sessionId),
          }),
          { env: { OPENCLAW_STATE_DIR: root } },
        );
      const before = read();
      expect(before?.session?.endedAt).toBeNull();
      expect(before?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "response", dataText: "legacy prefix" }),
          expect.objectContaining({ kind: "ws-frame", dataText: "host still active" }),
        ]),
      );
      expect(before?.rows.some((row) => row.dataText === "late legacy")).toBe(false);
      expect(before?.rows.some((row) => row.dataText === "host prefix")).toBe(false);
      capture.initializeDebugProxyCapture("legacy-reinitialized", settings, deps);
      const reopenedStore = getDebugProxyCaptureStore();
      capture.captureWsEvent(frame("legacy reopened"), settings, deps);
      await capture.finalizeDebugProxyCaptureAsync(settings, deps);
      await hostWriting;
      expect(reopenedStore.isClosed).toBe(true);
      expect(read()?.session?.endedAt).toBeTypeOf("number");
      expect(read()?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "response", dataText: "host prefix" }),
          expect.objectContaining({ kind: "ws-frame", dataText: "legacy reopened" }),
          expect.objectContaining({ kind: "response", path: "/after-legacy", dataText: "host" }),
        ]),
      );
    } finally {
      legacy.controller.close();
      host.controller.close();
      await capture.finalizeDebugProxyCaptureAsync(settings, deps);
      await hostWriting;
      await Promise.all([legacy.response.body?.cancel(), host.response.body?.cancel()]);
      await closeOpenClawStateDatabaseByPathAsync(path.join(root, "state", "openclaw.sqlite"));
    }
  });
}
