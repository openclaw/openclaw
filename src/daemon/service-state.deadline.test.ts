import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";
import { readGatewayServiceState } from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const command: GatewayServiceCommandConfig = {
  programArguments: ["/bin/node", "/opt/openclaw/entry.js", "gateway", "--port", "18789"],
  environment: { OPENCLAW_GATEWAY_PORT: "18789" },
};
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function deferredReaders() {
  const load = createDeferred<boolean>();
  const runtime = createDeferred<GatewayServiceRuntime>();
  const entered = createDeferred();
  const service = createMockGatewayService({
    readCommand: vi.fn(async () => command),
    isLoaded: vi.fn(() => load.promise),
    readRuntime: vi.fn(() => {
      entered.resolve();
      return runtime.promise;
    }),
  });
  return { load, runtime, entered, service };
}

describe("ordinary service inspection deadline", () => {
  it("preserves completed native unknown diagnostics after the shared allowance expires", async () => {
    const { load, runtime, entered, service } = deferredReaders();
    const nativeRuntime: GatewayServiceRuntime = {
      status: "unknown",
      detail: "native service inspection timed out",
      inspectionFailure: {
        code: "service-runtime-inspection-failed",
        detail: "native runtime timeout",
        timeoutMs: 100,
      },
    };
    const pending = readGatewayServiceState(service, { env: {}, timeoutMs: 100 });
    await entered.promise;
    now = 101;
    load.reject(new Error("native load timeout"));
    runtime.resolve(nativeRuntime);

    const state = await pending;
    expect(state.loadState).toEqual({ status: "unknown", detail: "Error: native load timeout" });
    expect(state.runtime).toBe(nativeRuntime);
    expect(state).toMatchObject({ installed: true, running: false, command });
    expect(service.isLoaded).toHaveBeenCalledWith({ env: command.environment, timeoutMs: 100 });
    expect(service.readRuntime).toHaveBeenCalledWith(command.environment, { timeoutMs: 100 });
  });

  it("does not promote positive runtime observations that settle after the deadline", async () => {
    const { load, runtime, entered, service } = deferredReaders();
    const pending = readGatewayServiceState(service, { env: {}, timeoutMs: 100 });
    await entered.promise;
    now = 101;
    load.resolve(true);
    runtime.resolve({ status: "running", pid: 4242 });

    const state = await pending;
    expect(state).toMatchObject({
      installed: true,
      running: false,
      loadState: { status: "unknown" },
      runtime: { status: "unknown" },
    });
    expect(state.runtime?.pid).toBeUndefined();
    expect(state.runtime?.missingUnit).not.toBe(true);
  });

  it("retains the command and merged environment without admitting native reads after expiry", async () => {
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => {
        now = 101;
        return command;
      }),
    });
    const state = await readGatewayServiceState(service, {
      env: { HOME: "/fixture" },
      timeoutMs: 100,
    });
    expect(state).toMatchObject({
      installed: true,
      command,
      env: { HOME: "/fixture", OPENCLAW_GATEWAY_PORT: "18789" },
      loadState: { status: "unknown" },
      runtime: { status: "unknown" },
      running: false,
    });
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readRuntime).not.toHaveBeenCalled();
  });

  it("does not admit any native reader when the allowance is already exhausted", async () => {
    const service = createMockGatewayService();
    const state = await readGatewayServiceState(service, { env: {}, timeoutMs: 0 });
    expect(state).toMatchObject({
      loadState: { status: "unknown" },
      runtime: { status: "unknown" },
      running: false,
    });
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readRuntime).not.toHaveBeenCalled();
  });

  it("does not use an absence observation returned after the deadline as stopped evidence", async () => {
    const service = createMockGatewayService({
      isAbsent: vi.fn(async () => {
        now = 101;
        return true;
      }),
    });
    const state = await readGatewayServiceState(service, { env: {}, timeoutMs: 100 });
    expect(state.loadState.status).toBe("unknown");
    expect(state.runtime?.status).toBe("unknown");
    expect(state.runtime?.missingUnit).not.toBe(true);
    expect(service.readCommand).not.toHaveBeenCalled();
  });

  it("keeps strict operation expiry a rejection", async () => {
    const { load, runtime, entered, service } = deferredReaders();
    const pending = readGatewayServiceState(service, {
      env: {},
      timeoutMs: 100,
      requireEffective: true,
    });
    const rejected = expect(pending).rejects.toThrow("Service inspection deadline expired.");
    await entered.promise;
    now = 101;
    load.resolve(false);
    runtime.resolve({ status: "unknown", detail: "native timeout" });
    await rejected;
  });

  it.each(
    (
      [
        "initial-absence",
        "strict-absence",
        "installed-definition",
        "definition-capability",
      ] as const
    ).flatMap((boundary) =>
      (["cleanup", "ownership"] as const).map((kind) => ({ boundary, kind })),
    ),
  )(
    "does not consume $kind refusal in the $boundary fallback after expiry",
    async ({ boundary, kind }) => {
      const error =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new ServiceOwnershipRefusalError("systemd-manager-changed");
      const refuse = vi.fn(async () => {
        now = 101;
        throw error;
      });
      const service = createMockGatewayService({ readCommand: vi.fn(async () => command) });
      if (boundary === "initial-absence") {
        service.isAbsent = refuse;
      } else if (boundary === "strict-absence") {
        service.readCommand = vi.fn(async () => null);
        service.isAbsent = vi.fn(async (args) => (args.strictCommandAbsent ? refuse() : false));
      } else if (boundary === "installed-definition") {
        service.readCommand = vi.fn(async () => null);
        service.hasInstalledDefinition = refuse;
      } else {
        service.readDefinitionMutationCapability = refuse;
      }
      await expect(
        readGatewayServiceState(service, {
          env: {},
          timeoutMs: 100,
          ...(boundary === "strict-absence" || boundary === "definition-capability"
            ? { requireEffective: true, requireLoadedCommand: true }
            : {}),
        }),
      ).rejects.toBe(error);
      expect(refuse).toHaveBeenCalledOnce();
    },
  );

  it.each(["cleanup", "ownership"] as const)(
    "joins admitted readers and preserves %s refusal after expiry",
    async (kind) => {
      const { load, runtime, entered, service } = deferredReaders();
      const error =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new ServiceOwnershipRefusalError("systemd-manager-changed");
      const pending = readGatewayServiceState(service, { env: {}, timeoutMs: 100 });
      const rejected = expect(pending).rejects.toBe(error);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await entered.promise;
      now = 101;
      runtime.reject(error);
      // Drain the owner's rejection propagation while keeping the sibling open.
      // A raw fixture-promise checkpoint would run before fail-fast propagation.
      await setImmediate();
      try {
        expect(settled).toBe(false);
      } finally {
        load.resolve(false);
      }
      await rejected;
      expect(settled).toBe(true);
    },
  );
});
