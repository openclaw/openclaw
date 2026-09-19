// Registered CLI -> in-process RPC -> real Gateway handlers and SQLite readback.
// The transport is controlled; no WebSocket, provider, or scheduled execution is claimed.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime, ExitError } from "../runtime.js";
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
  const program = new Command();
  program.exitOverride();
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

function agentAddArgs(name: string, thinking?: string): string[] {
  return [
    "add",
    "--name",
    name,
    "--every",
    "1h",
    "--agent",
    "main",
    "--message",
    "hello",
    "--disabled",
    "--no-deliver",
    ...(thinking === undefined ? [] : ["--thinking", thinking]),
  ];
}

async function withCronGateway(
  run: (fixture: {
    readJobs: () => Promise<CronJob[]>;
    writeScript: () => Promise<string>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-thinking", layout: "home" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } }, cron: { enabled: false } };
    await state.writeConfig(cfg);
    const storePath = state.statePath("cron", "jobs.json");
    const execute = vi.fn((): never => {
      throw new Error("A disabled thinking-validation job must not execute");
    });
    const cron = new CronService({
      storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: execute,
      requestHeartbeat: execute,
      runIsolatedAgentJob: execute,
      runCommandJob: execute,
      runScriptJob: execute,
    });
    try {
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
            const [ok, payload, error] = expectDefined(
              respond.mock.calls.at(-1),
              "Gateway response",
            );
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
    } finally {
      cron.stop();
    }
  });
}

afterEach(() => {
  callGatewayFromCli.mockReset();
  vi.restoreAllMocks();
});

describe("cron thinking mutation readback", () => {
  it("persists a valid thinking override through registered add", async () => {
    await withCronGateway(async ({ readJobs }) => {
      expect(await readJobs()).toEqual([]);
      const result = await runCli(agentAddArgs("valid-thinking", "high"));
      const jobs = await readJobs();
      console.log(
        "cron-thinking-readback",
        JSON.stringify({
          operation: "valid-add",
          exitCode: result.exitCode,
          errors: result.errors,
          methods: result.methods,
          rows: jobs.map(({ name, payload }) => ({ name, payload })),
        }),
      );
      expect(result.exitCode, result.errors.join("\n")).toBe(0);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toMatchObject({ kind: "agentTurn", thinking: "high" });
    });
  });

  it.each(["add", "edit", "edit after lookup"])(
    "rejects invalid thinking before %s can change stored jobs",
    async (operation) => {
      await withCronGateway(async ({ readJobs }) => {
        expect((await runCli(agentAddArgs("original", "high"))).exitCode).toBe(0);
        const before = await readJobs();
        const job = expectDefined(before[0], "valid seed job");
        const result = await runCli(
          operation === "add"
            ? agentAddArgs("invalid-add", "hihg")
            : [
                "edit",
                job.id,
                "--name",
                "invalid-edit",
                "--thinking",
                "hihg",
                ...(operation === "edit after lookup" ? ["--pacing-min", "5m"] : []),
              ],
        );
        const after = await readJobs();
        console.log(
          "cron-thinking-readback",
          JSON.stringify({
            operation,
            exitCode: result.exitCode,
            errors: result.errors,
            methods: result.methods,
            before: before.map(({ name, payload }) => ({ name, payload })),
            after: after.map(({ name, payload }) => ({ name, payload })),
          }),
        );
        expect(result.exitCode).toBe(1);
        expect(result.errors).toContainEqual(expect.stringContaining("Invalid --thinking"));
        expect(result.methods).not.toContain(operation === "add" ? "cron.add" : "cron.update");
        expect(after).toEqual(before);
      });
    },
  );

  it("preserves legal spellings, blank omission, and clear semantics on add and edit", async () => {
    await withCronGateway(async ({ readJobs }) => {
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
      expect((await runCli(agentAddArgs("edit-target", "high"))).exitCode).toBe(0);
      const target = expectDefined((await readJobs())[0], "edit target");
      for (const [index, thinking] of legal.entries()) {
        expect((await runCli(agentAddArgs(`legal-${index}`, thinking))).exitCode).toBe(0);
        expect((await runCli(["edit", target.id, "--thinking", thinking])).exitCode).toBe(0);
        const jobs = await readJobs();
        for (const name of [`legal-${index}`, "edit-target"]) {
          expect(jobs.find((job) => job.name === name)?.payload).toMatchObject({
            thinking: thinking.trim(),
          });
        }
      }
      for (const [index, blank] of ["", "   "].entries()) {
        expect((await runCli(agentAddArgs(`blank-${index}`, blank))).exitCode).toBe(0);
        expect(
          (await readJobs()).find((job) => job.name === `blank-${index}`)?.payload,
        ).not.toHaveProperty("thinking");
        expect(
          (await runCli(["edit", target.id, "--name", `renamed-${index}`, "--thinking", blank]))
            .exitCode,
        ).toBe(0);
        expect((await readJobs()).find((job) => job.id === target.id)).toMatchObject({
          name: `renamed-${index}`,
          payload: { thinking: "extra_high" },
        });
      }
      for (const thinking of ["high", "", "   "]) {
        const before = await readJobs();
        const result = await runCli([
          "edit",
          target.id,
          "--thinking",
          thinking,
          "--clear-thinking",
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.errors).toContainEqual(
          expect.stringContaining("Use --thinking or --clear-thinking, not both"),
        );
        expect(result.methods).not.toContain("cron.update");
        expect(await readJobs()).toEqual(before);
      }
      expect((await runCli(["edit", target.id, "--clear-thinking"])).exitCode).toBe(0);
      expect((await readJobs()).find((job) => job.id === target.id)?.payload).not.toHaveProperty(
        "thinking",
      );
    });
  });

  it.each(["systemEvent", "command", "script"])(
    "keeps unused thinking ignored when adding a %s job",
    async (kind) => {
      await withCronGateway(async ({ readJobs, writeScript }) => {
        const payloadArgs =
          kind === "systemEvent"
            ? ["--system-event", "hello"]
            : kind === "command"
              ? ["--command-argv", '["printf","hello"]', "--no-deliver"]
              : ["--script", await writeScript(), "--no-deliver"];
        const result = await runCli([
          "add",
          "--name",
          kind,
          "--every",
          "1h",
          "--agent",
          "main",
          "--disabled",
          ...payloadArgs,
          "--thinking",
          "hihg",
        ]);
        const jobs = await readJobs();
        expect(result.exitCode).toBe(0);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.payload.kind).toBe(kind);
        expect(jobs[0]?.payload).not.toHaveProperty("thinking");
      });
    },
  );
});
