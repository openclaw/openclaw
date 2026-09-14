import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
  type GatewayServiceNativeCommand,
} from "./service-update-authority.js";

it("revokes a captured native runner when its service authority scope closes", async () => {
  let captured: GatewayServiceNativeCommand | undefined;
  let effects = 0;
  await withGatewayServiceUpdateAuthority(
    () => undefined,
    async () => {
      captured = getGatewayServiceUpdateNativeCommand();
    },
    async () => {
      effects += 1;
      return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
    },
  );
  if (!captured) {
    throw new Error("Missing fixture native runner");
  }
  await expect(captured(["unused-native"], {})).rejects.toThrow("has closed");
  expect(effects).toBe(0);
});

const result = {
  stdout: "native",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};

it("serializes parallel native reads before checking a suspended parent", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const commands: string[] = [];
  let running = false;
  await withGatewayServiceUpdateAuthority(
    () => {
      if (running) {
        throw new Error("parent is suspended");
      }
    },
    async () => {
      const first = execFileUtf8("first", []);
      await entered.promise;
      const second = execFileUtf8("second", []);
      expect(commands).toEqual(["first"]);
      release.resolve();
      const completed = await Promise.all([first, second]);
      expect(completed.map((entry) => entry.code)).toEqual([0, 0]);
      expect(commands).toEqual(["first", "second"]);
    },
    async (argv) => {
      running = true;
      commands.push(argv[0]!);
      try {
        if (argv[0] === "first") {
          entered.resolve();
          await release.promise;
        }
        return result;
      } finally {
        running = false;
      }
    },
  );
});

it("expires a queued deadline without invoking it or releasing its predecessor", async () => {
  vi.useFakeTimers();
  const entered = createDeferred();
  const release = createDeferred();
  const commands: string[] = [];
  let expired = false;
  try {
    const scope = withGatewayServiceUpdateAuthority(
      () => undefined,
      async () => {
        const runner = getGatewayServiceUpdateNativeCommand();
        if (!runner) {
          throw new Error("missing native fixture");
        }
        const first = runner(["first"], {});
        await entered.promise;
        const queued = runner(["expired"], { timeoutMs: 20 });
        const refusal = expect(queued).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(25);
        await refusal;
        expired = true;
        expect(commands).toEqual(["first"]);
        release.resolve();
        await first;
        throw new Error("fixture complete after expiry");
      },
      async (argv) => {
        commands.push(argv[0]!);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    await expect(scope).rejects.toThrow();
    expect(expired).toBe(true);
    expect(commands).toEqual(["first"]);
  } finally {
    release.resolve();
    vi.useRealTimers();
  }
});

it("closes unstarted submissions but joins the already running native call", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const commands: string[] = [];
  let done = false;
  const work = withGatewayServiceUpdateAuthority(
    () => undefined,
    async () => {
      const runner = getGatewayServiceUpdateNativeCommand();
      if (!runner) {
        throw new Error("missing native fixture");
      }
      void runner(["first"], {}).catch(() => undefined);
      await entered.promise;
      void runner(["never"], {}).catch(() => undefined);
      throw new Error("initiating failure");
    },
    async (argv) => {
      commands.push(argv[0]!);
      entered.resolve();
      await release.promise;
      return result;
    },
  ).finally(() => {
    done = true;
  });
  const refused = expect(work).rejects.toThrow();
  await entered.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  expect(commands).toEqual(["first"]);
  release.resolve();
  await refused;
  expect(commands).toEqual(["first"]);
});
