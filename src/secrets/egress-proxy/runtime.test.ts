import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { SecretEgressProxyAuditEvent } from "./proxy-server.js";
import { startGatewaySecretEgressProxy } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  stateDir: "",
  startWorker: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// mock-isolation: Keep state directory resolution inside this fixture's temporary directory.
vi.mock("../../config/paths.js", () => ({ resolveStateDir: () => mocks.stateDir }));
// mock-isolation: Observe diagnostic levels without opening real log sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => mocks.log }));
// mock-isolation: Deliver worker audit events without launching TLS or a worker thread.
vi.mock("./proxy-worker.js", () => ({ startSecretEgressProxyWorker: mocks.startWorker }));

const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
});

describe("secret egress runtime diagnostics", () => {
  it("keeps routine forwarding at debug while counting every outcome", async () => {
    mocks.stateDir = dirs.make("egress-runtime-");
    let audit: (event: SecretEgressProxyAuditEvent) => void = () => {
      throw new Error("worker not started");
    };
    mocks.startWorker.mockImplementationOnce(async (options) => {
      audit = options.onAudit;
      return { stop: vi.fn(async () => {}) };
    });
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event), {
      include: ["secret.egress"],
    });
    const proxy = await startGatewaySecretEgressProxy({});
    try {
      const cases: Array<{ event: SecretEgressProxyAuditEvent; level: "debug" | "info" | "warn" }> =
        [
          { event: { kind: "forwarded", host: "example.com", substituted: false }, level: "debug" },
          {
            event: { kind: "forwarded", host: "example.com", substituted: false, reason: "bypass" },
            level: "debug",
          },
          { event: { kind: "forwarded", host: "example.com", substituted: true }, level: "debug" },
          { event: { kind: "refused", host: "example.com", substituted: false }, level: "info" },
          {
            event: {
              kind: "refused",
              host: "example.com",
              substituted: false,
              reason: "certificate-error",
            },
            level: "warn",
          },
        ];
      for (const { event, level } of cases) {
        vi.clearAllMocks();
        audit(event);
        expect(mocks.log[level]).toHaveBeenCalledWith(expect.any(String), event);
        for (const other of ["debug", "info", "warn"] as const) {
          expect(mocks.log[other]).toHaveBeenCalledTimes(other === level ? 1 : 0);
        }
      }
      expect(events).toEqual(
        cases.map(({ event }) => ({
          type: "secret.egress",
          outcome: event.kind,
          substituted: event.substituted,
          seq: expect.any(Number),
          ts: expect.any(Number),
        })),
      );
    } finally {
      unsubscribe();
      await proxy.stop();
    }
  });
});
