import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { execFileUtf8 } from "./exec-file.js";
import { withServiceInspectionBudget } from "./service-inspection-budget.js";
import {
  getGatewayServiceUpdateNativeCommand as getNativeCommand,
  withGatewayServiceUpdateAuthority as withUpdateAuthority,
  withGatewayServiceInstallationRecovery as recoverInstallation,
  type GatewayServiceNativeCommand,
} from "./service-update-authority.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nativeRunner = () => expectDefined(getNativeCommand(), "missing native fixture");

function blockedNative() {
  const entered = createDeferred();
  const release = createDeferred();
  const commands: string[] = [];
  const state = { running: false };
  const nativeCommand: GatewayServiceNativeCommand = async (argv) => {
    state.running = true;
    commands.push(argv[0]!);
    try {
      if (argv[0] === "first") {
        entered.resolve();
        await release.promise;
      }
      return result;
    } finally {
      state.running = false;
    }
  };
  function run<T>(operation: () => Promise<T>, assertOwner?: () => void) {
    return withUpdateAuthority(assertOwner, operation, { nativeCommand });
  }
  return { entered, release, commands, state, run };
}

it("revokes a captured native runner when its service authority scope closes", async () => {
  const nativeCommand = vi.fn(async () => result);
  const captured = await withUpdateAuthority(undefined, async () => nativeRunner(), {
    nativeCommand,
  });
  await expect(captured(["unused-native"], {})).rejects.toThrow("has closed");
  expect(nativeCommand).not.toHaveBeenCalled();
});

const result = createCommandResult({ stdout: "native" });

it("expires a queued deadline without invoking it or releasing its predecessor", async () => {
  vi.useFakeTimers();
  const { entered, release, commands, run } = blockedNative();
  let expired = false;
  try {
    const scope = run(async () => {
      const runner = nativeRunner();
      const first = runner(["first"], {});
      await entered.promise;
      const refusal = expect(runner(["expired"], { timeoutMs: 20 })).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(25);
      await refusal;
      expired = true;
      expect(commands).toEqual(["first"]);
      release.resolve();
      await first;
      throw new Error("fixture complete after expiry");
    });
    await expect(scope).rejects.toThrow();
    expect({ expired, commands }).toEqual({ expired: true, commands: ["first"] });
  } finally {
    release.resolve();
  }
});

it("keeps a queued deadline on the monotonic clock across wall-clock jumps", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
  const { entered, release, commands, run } = blockedNative();
  try {
    await run(async () => {
      const runner = nativeRunner();
      const first = runner(["first"], {});
      await entered.promise;
      const queued = runner(["survives"], { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(5);
      vi.setSystemTime(60_000);
      release.resolve();
      await expect(queued).resolves.toMatchObject({ code: 0 });
      expect(commands).toEqual(["first", "survives"]);
      await first;
    });
  } finally {
    release.resolve();
  }
});

it("closes unstarted submissions but joins the already running native call", async () => {
  const { entered, release, commands, run } = blockedNative();
  let done = false;
  const work = run(async () => {
    const runner = nativeRunner();
    void runner(["first"], {}).catch(() => undefined);
    await entered.promise;
    void runner(["never"], {}).catch(() => undefined);
    throw new Error("initiating failure");
  }).finally(() => {
    done = true;
  });
  const refused = expect(work).rejects.toThrow();
  await entered.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect({ done, commands }).toEqual({ done: false, commands: ["first"] });
  release.resolve();
  await refused;
  expect(commands).toEqual(["first"]);
});

it.each(["direct", "nested", "revoked"] as const)("serializes custody (%s)", async (scope) => {
  const { entered, release, commands, run, state } = blockedNative();
  let current = true;
  const invoke = async () => {
    const first = execFileUtf8("first", []);
    await entered.promise;
    const second = execFileUtf8("second", []);
    expect(commands).toEqual(["first"]);
    const settled = Promise.allSettled([first, second]);
    current = scope !== "revoked";
    release.resolve();
    const expected =
      scope === "revoked" ? { status: "rejected" } : { status: "fulfilled", value: { code: 0 } };
    expect(await settled).toMatchObject([expected, expected]);
  };
  const work = run(
    () =>
      scope === "direct"
        ? invoke()
        : withUpdateAuthority(() => assert(current, "nested custody revoked"), invoke, {
            updateOwned: false,
            nativeCommand: getNativeCommand(),
          }),
    () => assert(!state.running, "parent is suspended"),
  );
  if (scope === "revoked") {
    await expect(work).rejects.toThrow("nested custody revoked");
  } else {
    await work;
  }
  expect(commands).toEqual(scope === "revoked" ? ["first"] : ["first", "second"]);
});

it.each(["settled", "thrown", "returned"] as const)("guards compensation (%s)", async (kind) => {
  const commands: string[] = [];
  let current = true;
  const restore = vi.fn(async () => {
    await execFileUtf8("restore", []);
    return true;
  });
  const nativeCommand: GatewayServiceNativeCommand = async ([command]) => {
    commands.push(command!);
    if (command !== "publish") {
      return result;
    }
    current = false;
    if (kind === "thrown") {
      throw new CommandProcessCleanupError();
    }
    return kind === "returned" ? { ...result, cleanup: "uncertain" } : result;
  };
  const work = withUpdateAuthority(
    undefined,
    () =>
      withUpdateAuthority(
        () => assert(current, "nested custody revoked"),
        () => recoverInstallation(() => execFileUtf8("publish", []), restore),
        {
          updateOwned: false,
          assertRecoveryCurrent: () => undefined,
          nativeCommand: getNativeCommand(),
        },
      ),
    { nativeCommand },
  );
  if (kind === "settled") {
    await expect(work).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome: "restored",
    });
  } else {
    await expect(work).rejects.toSatisfy(hasCommandProcessCleanupError);
    expect(restore).not.toHaveBeenCalled();
  }
  expect(commands).toEqual(kind === "settled" ? ["publish", "restore"] : ["publish"]);
});

it("does not spend a native inspection queue's execution allowance on live custody", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const native = vi.fn<GatewayServiceNativeCommand>(async (_argv, options) => {
    expect(options.timeoutMs).toBe(100);
    now += 10;
    return result;
  });
  await withServiceInspectionBudget(async (budget) => {
    await withUpdateAuthority(
      () => {
        now += 2_000;
      },
      () => execFileUtf8("busctl", [], { timeout: 100 }),
      { nativeCommand: native },
    );
    expect(budget.now()).toBe(10);
  });
  expect(native).toHaveBeenCalledOnce();
});
