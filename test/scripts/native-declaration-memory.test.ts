import { expect, it } from "vitest";
import { resolveNativeDeclarationCompilerEnv } from "../../scripts/lib/native-declaration-memory.mts";
import { budgetStagedDeclarationInvocations } from "../../scripts/lib/tsdown-declaration-writer.mts";
import {
  resolveTsdownBuildInvocation,
  type prepareTsdownBuildExecution,
} from "../../scripts/tsdown-build.mts";

const GIB = 1024 ** 3;
const MEMORY_FIXTURE = {
  cgroupMemoryLimitPaths: [],
  constrainedMemoryBytes: 0,
  platform: "darwin",
  procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
};

it("bounds native declaration Go memory on a 10GiB host", () => {
  const env = resolveNativeDeclarationCompilerEnv({
    ...MEMORY_FIXTURE,
    env: {},
    physicalMemoryBytes: 16 * GIB,
    availableMemoryBytes: 16 * GIB,
    cgroupMemoryLimitBytes: 10 * GIB,
  });
  expect(env.GOMEMLIMIT).toBe("6144MiB");
});

it("scales native declaration Go memory on a larger host", () => {
  const env = resolveNativeDeclarationCompilerEnv({
    ...MEMORY_FIXTURE,
    env: {},
    physicalMemoryBytes: 24 * GIB,
    availableMemoryBytes: 24 * GIB,
  });
  expect(env.GOMEMLIMIT).toBe("14745MiB");
});

it("preserves an explicit Go limit", () => {
  const env = { GOMEMLIMIT: "5GiB" };
  expect(resolveNativeDeclarationCompilerEnv({ env, cgroupMemoryLimitBytes: 10 * GIB })).toBe(env);
});

it("splits the automatic Go budget between two simultaneous compiler children", () => {
  const params = {
    ...MEMORY_FIXTURE,
    env: {},
    physicalMemoryBytes: 24 * GIB,
    availableMemoryBytes: 24 * GIB,
  };
  const invocations: NonNullable<ReturnType<typeof prepareTsdownBuildExecution>>["invocations"] = [
    { command: "tsdown", args: [], options: { stdio: [], shell: false, env: {} } },
    { command: "tsdown", args: [], options: { stdio: [], shell: false, env: {} } },
  ];
  const budgeted = budgetStagedDeclarationInvocations(invocations, 2, params);
  expect(budgeted.map((invocation) => invocation.options.env.GOMEMLIMIT)).toEqual([
    "7372MiB",
    "7372MiB",
  ]);
  expect(invocations.every((invocation) => invocation.options.env.GOMEMLIMIT === undefined)).toBe(
    true,
  );
  expect(
    budgetStagedDeclarationInvocations(invocations, 1, params).map(
      (invocation) => invocation.options.env.GOMEMLIMIT,
    ),
  ).toEqual(["14745MiB", "14745MiB"]);
  const overridden = budgetStagedDeclarationInvocations(
    [{ ...invocations[0]!, options: { ...invocations[0]!.options, env: { GOMEMLIMIT: "9GiB" } } }],
    2,
    params,
  );
  expect(overridden[0]?.options.env.GOMEMLIMIT).toBe("9GiB");
});

it("passes the Go budget through direct declaration worker environments", () => {
  const params = {
    ...MEMORY_FIXTURE,
    env: {},
    physicalMemoryBytes: 16 * GIB,
    availableMemoryBytes: 16 * GIB,
    cgroupMemoryLimitBytes: 10 * GIB,
    args: ["--config", "tsdown.config.ts", "--filter", "openclaw-dts-base"],
  };
  expect(resolveTsdownBuildInvocation(params).options.env.GOMEMLIMIT).toBe("6144MiB");
  expect(
    resolveTsdownBuildInvocation({ ...params, args: [...params.args, "--concurrency", "3"] })
      .options.env.GOMEMLIMIT,
  ).toBe("2048MiB");
  expect(
    resolveTsdownBuildInvocation({ ...params, env: { GOMEMLIMIT: "6GiB" } }).options.env.GOMEMLIMIT,
  ).toBe("6GiB");
  expect(
    resolveTsdownBuildInvocation({ ...params, args: [...params.args, "--watch"] }).options.env
      .GOMEMLIMIT,
  ).toBeUndefined();
  expect(
    resolveTsdownBuildInvocation({ ...params, deferNativeDeclarationMemory: true }).options.env
      .GOMEMLIMIT,
  ).toBeUndefined();
  expect(
    resolveTsdownBuildInvocation({ ...params, args: [...params.args, "--no-dts"] }).options.env
      .GOMEMLIMIT,
  ).toBeUndefined();
  expect(
    resolveTsdownBuildInvocation({
      ...params,
      args: ["--config", "tsdown.config.ts", "--filter", "openclaw-unified"],
    }).options.env.GOMEMLIMIT,
  ).toBeUndefined();
});
