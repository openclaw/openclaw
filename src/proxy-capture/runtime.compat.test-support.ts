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

export function registerMixedCaptureLifecycleTests({
  stateRoot,
  captureSettings,
  pendingResponse,
}: {
  stateRoot: () => string;
  captureSettings: (root: string, sessionId: string) => DebugProxySettings;
  pendingResponse: (chunks: Buffer[]) => {
    response: Response;
    controller: ReadableStreamDefaultController<Uint8Array>;
    pending: Promise<void>;
  };
}): void {
  it.each(["legacy-first", "async-first"])(
    "settles legacy capture independently of host worker capture (%s)",
    async (order) => {
      const root = stateRoot();
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const settings = captureSettings(root, "mixed-lifecycle");
      const fetchTarget: typeof globalThis = {
        ...globalThis,
        fetch: vi.fn(async () => new Response("host")),
      };
      const deps = { fetchTarget };
      const ws = (
        write: typeof capture.captureWsEvent | typeof capture.captureWsEventAsync,
        route: string,
        flowId: string,
        payload: string,
      ) =>
        write(
          {
            url: `wss://example.test/${route}`,
            kind: "ws-frame",
            direction: "outbound",
            flowId,
            payload,
          },
          settings,
          deps,
        );
      const legacy = pendingResponse([Buffer.from("legacy prefix")]);
      const host = pendingResponse([Buffer.from("host prefix")]);
      let hostWriting: Promise<void> | undefined;
      try {
        if (order === "legacy-first") {
          capture.initializeDebugProxyCapture("legacy-plugin", settings, deps);
          await capture.initializeDebugProxyCaptureAsync("host", settings, deps);
        } else {
          await capture.initializeDebugProxyCaptureAsync("host", settings, deps);
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
        ws(capture.captureWsEvent, "late", "late-legacy", "late legacy");
        await fetchTarget.fetch("https://example.test/after-legacy");
        await ws(capture.captureWsEventAsync, "host", "host-live", "host still active");
        const read = () =>
          withExistingOpenClawStateDatabaseReadOnly(
            ({ db }) => ({
              session: listDebugProxyCaptureSessions(db).find(
                (row) => row.id === settings.sessionId,
              ),
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
        ws(capture.captureWsEvent, "reopened", "legacy-reopened", "legacy reopened");
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
    },
  );
}
