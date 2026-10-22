// Registered CLI -> in-process RPC -> real Gateway handlers and SQLite readback.
// The transport is controlled; no WebSocket, provider, or scheduled execution is claimed.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";
import type { CronJob } from "./types.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCli,
}));

const { registerCronCli } = await import("../cli/cron-cli.js");

function wireValue(value: unknown): unknown {
  // The real JSON transport omits undefined properties, unlike structuredClone.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function runCli(args: string[]) {
  callGatewayFromCli.mockClear();
  const errors: string[] = [];
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation((...values) => {
    errors.push(values.map(String).join(" "));
  });
  const outputSpy = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const program = new Command().exitOverride();
  registerCronCli(program);
  let exitCode = 0;
  try {
    await program.parseAsync(["cron", ...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  } finally {
    errorSpy.mockRestore();
    outputSpy.mockRestore();
  }
  return {
    exitCode,
    errors,
    methods: callGatewayFromCli.mock.calls.map(([method]) => String(method)),
  };
}

function addArgs(name: string, payload: string[], ...options: string[]): string[] {
  const defaults = ["--every", "1h", "--agent", "main", "--disabled"];
  return ["add", "--name", name, ...defaults, ...payload, ...options];
}

function agentAddArgs(name: string, thinking: string): string[] {
  return addArgs(name, ["--message", "hello", "--no-deliver"], "--thinking", thinking);
}

async function succeeds(args: string[]) {
  expect((await runCli(args)).exitCode).toBe(0);
}

function expectRejected(result: Awaited<ReturnType<typeof runCli>>, error: string, method: string) {
  expect(result).toMatchObject({
    exitCode: 1,
    errors: expect.arrayContaining([expect.stringContaining(error)]),
  });
  expect(result.methods).not.toContain(method);
}

function edit(id: string, ...options: string[]) {
  return ["edit", id, ...options];
}

async function withCronGateway(
  run: (fixture: {
    readJobs: () => Promise<CronJob[]>;
    writeScript: () => Promise<string>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-thinking", layout: "home" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { model: "openai/gpt-4.1" } },
      cron: { enabled: false },
    };
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:thinking-fixture": {
          type: "api_key",
          provider: "openai",
          key: "synthetic-thinking-inference-key",
        },
      },
    });
    await state.writeConfig(cfg);
    const storePath = state.statePath("cron", "jobs.json");
    const execute = vi.fn((): never => {
      throw new Error("A disabled thinking-validation job must not execute");
    });
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: execute,
      runIsolatedAgentJob: execute,
      runCommandJob: execute,
      runScriptJob: execute,
    });
    using _ = { [Symbol.dispose]: () => cron.stop() };
    await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => cfg }, async () => {
      const context: GatewayRequestContext = {
        ...expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local Gateway context"),
        cron,
        cronStorePath: storePath,
      };
      callGatewayFromCli.mockImplementation(
        async (method: string, _options: unknown, params: Record<string, unknown> = {}) => {
          const respond = vi.fn<RespondFn>();
          const requestParams = wireValue(params) as Record<string, unknown>;
          await expectDefined(
            cronHandlers[method],
            `Gateway handler ${method}`,
          )({
            req: { type: "req", id: "cron-thinking", method, params: requestParams },
            params: requestParams,
            client: null,
            context,
            respond,
            isWebchatConnect: () => false,
          });
          const [ok, payload, error] = expectDefined(respond.mock.calls.at(-1), "Gateway response");
          if (!ok) {
            throw new Error(error?.message ?? `${method} failed`);
          }
          return wireValue(payload);
        },
      );
      await run({
        readJobs: async () =>
          (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env)).store.jobs,
        writeScript: () => state.writeText("thinking-control.js", 'return { notify: "done" };'),
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });
}

afterEach(() => {
  callGatewayFromCli.mockReset();
  vi.restoreAllMocks();
});

it.each(["add", "edit", "edit after lookup"])(
  "rejects invalid thinking before %s can change stored jobs",
  (operation) =>
    withCronGateway(async ({ readJobs }) => {
      await succeeds(agentAddArgs("original", "high"));
      const before = await readJobs();
      const job = expectDefined(before[0], "valid seed job");
      const result = await runCli(
        operation === "add"
          ? agentAddArgs("invalid-add", "hihg")
          : edit(
              job.id,
              "--name",
              "invalid-edit",
              "--thinking",
              "hihg",
              ...(operation === "edit after lookup" ? ["--pacing-min", "5m"] : []),
            ),
      );
      expectRejected(
        result,
        "Invalid --thinking",
        operation === "add" ? "cron.add" : "cron.update",
      );
      expect(await readJobs()).toEqual(before);
    }),
);

it("preserves legal spellings, blank omission, and clear semantics on add and edit", () =>
  withCronGateway(async ({ readJobs }) => {
    const legal = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
      "none",
      "mid",
      "extra-high",
      "AUTO",
      "enabled",
      "  High  ",
      " extra_high ",
    ];
    await succeeds(agentAddArgs("edit-target", "high"));
    const seeded = await readJobs();
    expect(seeded).toHaveLength(1);
    const target = expectDefined(seeded[0], "edit target");
    expect(target.payload).toMatchObject({ kind: "agentTurn", thinking: "high" });
    for (const [index, thinking] of legal.entries()) {
      await succeeds(agentAddArgs(`legal-${index}`, thinking));
      await succeeds(edit(target.id, "--thinking", thinking));
      const jobs = await readJobs();
      for (const name of [`legal-${index}`, "edit-target"]) {
        expect(jobs.find((job) => job.name === name)?.payload).toMatchObject({
          thinking: thinking.trim(),
        });
      }
    }
    for (const [index, blank] of ["", "   "].entries()) {
      await succeeds(agentAddArgs(`blank-${index}`, blank));
      expect(
        (await readJobs()).find((job) => job.name === `blank-${index}`)?.payload,
      ).not.toHaveProperty("thinking");
      await succeeds(edit(target.id, "--name", `renamed-${index}`, "--thinking", blank));
      expect((await readJobs()).find((job) => job.id === target.id)).toMatchObject({
        name: `renamed-${index}`,
        payload: { thinking: "extra_high" },
      });
    }
    for (const thinking of ["high", "", "   "]) {
      const before = await readJobs();
      const result = await runCli(edit(target.id, "--thinking", thinking, "--clear-thinking"));
      expectRejected(result, "Use --thinking or --clear-thinking, not both", "cron.update");
      expect(await readJobs()).toEqual(before);
    }
    await succeeds(edit(target.id, "--clear-thinking"));
    expect((await readJobs()).find((job) => job.id === target.id)?.payload).not.toHaveProperty(
      "thinking",
    );
  }));

it.each(["systemEvent", "command", "script"])(
  "keeps unused thinking ignored when adding a %s job",
  (kind) =>
    withCronGateway(async ({ readJobs, writeScript }) => {
      const payloadArgs =
        kind === "systemEvent"
          ? ["--system-event", "hello"]
          : kind === "command"
            ? ["--command-argv", '["printf","hello"]', "--no-deliver"]
            : ["--script", await writeScript(), "--no-deliver"];
      const result = await runCli(addArgs(kind, payloadArgs, "--thinking", "hihg"));
      const jobs = await readJobs();
      expect(result.exitCode).toBe(0);
      expect(jobs).toMatchObject([{ payload: { kind } }]);
      expect(jobs[0]?.payload).not.toHaveProperty("thinking");
    }),
);
