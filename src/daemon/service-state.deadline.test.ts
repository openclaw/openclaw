import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import { fingerprintGatewayServiceDefinition } from "./service-rebind.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayService, ReadGatewayServiceStateArgs } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { readGatewayServiceState } from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const command = { programArguments: ["node", "gateway"], environment: { PORT: "18789" } };
let now = 0;
const unknown = { status: "unknown" };
const unknownState = { loadState: unknown, runtime: unknown, running: false };
const boundaries = ["initial-absence", "strict-absence", "installed", "capability"] as const;
const refusals = ["cleanup", "ownership"] as const;
function inspect(service: GatewayService, options: ReadGatewayServiceStateArgs = {}) {
  return readGatewayServiceState(service, { env: {}, timeoutMs: 100, ...options });
}
function refusal(kind: "cleanup" | "ownership") {
  return kind === "cleanup"
    ? new CommandProcessCleanupError()
    : new ServiceOwnershipRefusalError("systemd-manager-changed");
}
function expire<T>(value: T) {
  now = 101;
  return value;
}
function guarded<T>(value: T, spent = 0) {
  return vi.fn(async () => {
    assertGatewayServiceUpdateCurrent();
    now += spent;
    return value;
  });
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

it.each(["ready", "absent", "command-failed", "runtime-failed", "deadline"] as const)(
  "retains only a successful same-read executable observation: %s",
  async (outcome) => {
    const service = createMockGatewayService({
      readCommand: vi.fn<GatewayService["readCommand"]>(async (_env, options) => {
        options?.onEffectiveExecutable?.("/runtime/bun");
        if (outcome === "command-failed") {
          throw new Error("native cleanup failed");
        }
        return outcome === "absent" ? null : command;
      }),
      readRuntime: vi.fn(async () => {
        if (outcome === "runtime-failed") {
          throw new Error("runtime inspection failed");
        }
        return outcome === "deadline"
          ? expire({ status: "stopped" as const })
          : { status: "stopped" as const };
      }),
    });
    const state = await inspect(service);
    expect(state.effectiveExecutable).toBe(outcome === "ready" ? "/runtime/bun" : undefined);
    if (outcome === "ready") {
      expect(state.command).toBe(command);
      expect(await fingerprintGatewayServiceDefinition(state.command)).toBe(
        await fingerprintGatewayServiceDefinition(command),
      );
      expect(command).not.toHaveProperty("effectiveExecutable");
    }
  },
);

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

it.each(["diagnostic", "positive", "strict"] as const)(
  "expires late native observations: %s",
  async (scenario) => {
    const { load, runtime, entered, service } = deferredReaders();
    const nativeRuntime: GatewayServiceRuntime =
      scenario === "positive"
        ? { status: "running", pid: 4242 }
        : { status: "unknown", detail: "native timeout" };
    const pending = inspect(service, { requireEffective: scenario === "strict" });
    const rejected =
      scenario === "strict"
        ? expect(pending).rejects.toThrow("Service inspection deadline expired.")
        : undefined;
    await entered.promise;
    if (scenario === "diagnostic") {
      load.reject(new Error("load timeout"));
    } else {
      load.resolve(scenario === "positive");
    }
    runtime.resolve(expire(nativeRuntime));
    if (rejected) {
      await rejected;
      return;
    }
    const state = await pending;
    expect(state).toMatchObject({ ...unknownState, installed: true, command });
    if (scenario === "diagnostic") {
      expect(state.loadState).toEqual({ status: "unknown", detail: "Error: load timeout" });
      expect(state.runtime).toBe(nativeRuntime);
      expect(service.isLoaded).toHaveBeenCalledWith({ env: command.environment, timeoutMs: 100 });
      expect(service.readRuntime).toHaveBeenCalledWith(command.environment, { timeoutMs: 100 });
    } else {
      expect(state.runtime?.pid).toBeUndefined();
      expect(state.runtime?.missingUnit).not.toBe(true);
    }
  },
);

it.each(["initial", "command", "absence"] as const)(
  "blocks native reads after expiry at %s",
  async (boundary) => {
    const service = createMockGatewayService();
    if (boundary === "command") {
      service.readCommand = vi.fn(async () => expire(command));
    } else if (boundary === "absence") {
      service.isAbsent = vi.fn(async () => expire(true));
    }
    const state = await inspect(service, {
      env: { HOME: "/fixture" },
      timeoutMs: boundary === "initial" ? 0 : 100,
    });
    expect(state).toMatchObject(unknownState);
    if (boundary === "command") {
      expect(state).toMatchObject({
        installed: true,
        command,
        env: { HOME: "/fixture", PORT: "18789" },
      });
    } else {
      expect(service.readCommand).not.toHaveBeenCalled();
    }
    expect(state.runtime?.missingUnit).not.toBe(true);
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readRuntime).not.toHaveBeenCalled();
  },
);

it.each(boundaries.flatMap((boundary) => refusals.map((kind) => ({ boundary, kind }))))(
  "preserves expired $boundary refusal: $kind",
  async ({ boundary, kind }) => {
    const error = refusal(kind);
    const refuse = vi.fn(async () => {
      throw expire(error);
    });
    const service = createMockGatewayService({ readCommand: vi.fn(async () => command) });
    if (boundary === "initial-absence") {
      service.isAbsent = refuse;
    } else if (boundary === "strict-absence") {
      service.readCommand = vi.fn(async () => null);
      service.isAbsent = vi.fn(async (args) => (args.strictCommandAbsent ? refuse() : false));
    } else if (boundary === "installed") {
      service.readCommand = vi.fn(async () => null);
      service.hasInstalledDefinition = refuse;
    } else {
      service.readDefinitionMutationCapability = refuse;
    }
    const strict = boundary === "strict-absence" || boundary === "capability";
    await expect(
      inspect(service, { requireEffective: strict, requireLoadedCommand: strict }),
    ).rejects.toBe(error);
    expect(refuse).toHaveBeenCalledOnce();
  },
);

it.each(refusals)("joins readers before propagating expired %s refusal", async (kind) => {
  const { load, runtime, entered, service } = deferredReaders();
  const error = refusal(kind);
  const pending = inspect(service);
  const rejected = expect(pending).rejects.toBe(error);
  let settled = false;
  const onSettled = () => {
    settled = true;
  };
  void pending.then(onSettled, onSettled);
  await entered.promise;
  runtime.reject(expire(error));
  // Let owner rejection handlers run while the sibling remains pending.
  await setImmediate();
  try {
    expect(settled).toBe(false);
  } finally {
    load.resolve(false);
  }
  await rejected;
});

it.each([1, 101])("excludes custody but charges %s ms of native work", async (spent) => {
  const service = createMockGatewayService({
    readCommand: guarded(command),
    isLoaded: guarded(true),
    readRuntime: guarded({ status: "running" as const, pid: 4242 }, spent),
  });
  const work = withGatewayServiceUpdateAuthority(
    () => {
      now += 2_000;
    },
    () => inspect(service, { requireEffective: true }),
  );
  if (spent > 100) {
    await expect(work).rejects.toThrow("Service inspection deadline expired.");
  } else {
    await expect(work).resolves.toMatchObject({ running: true, command });
  }
});
