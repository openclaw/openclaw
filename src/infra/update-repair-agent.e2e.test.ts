import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { updateRepairWorkerMessageSchema as releasedUpdateRepairWorkerMessageSchema } from "./test-fixtures/update-repair-protocol.v2026-9-4.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import { repairModel } from "./update-repair-agent.test-support.js";
import {
  updateRepairBudgetSchema,
  type UpdateRepairParams,
  type UpdateRepairResult,
  type UpdateRepairTurnResult,
  type UpdateRepairWorkerMessage,
} from "./update-repair-protocol.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "./update-run-ledger.js";

// Manual triage retains the shared in-process loop. Load its built runtime through
// Node's loader, as the CLI does; worker cases already use the packaged child.
vi.mock("./update-repair-agent.runtime.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(
    "../../dist/update-repair-agent.runtime.js",
  ) as typeof import("./update-repair-agent.runtime.js");
});

type TurnDelegation = {
  runId?: string;
  admissionEnv: NodeJS.ProcessEnv;
  executor: { grant: UpdateCommandChildGrant; bindChild?: (pid: number) => void } | "unowned";
};
const requester = { channel: "synthetic", senderId: "owner" };

type RepairDiagnostics = {
  stdoutTail: string;
  stderrTail: string;
};

async function runRepairEnvelope(
  params: UpdateRepairParams,
  diagnostics: RepairDiagnostics,
  delegation?: TurnDelegation,
): Promise<UpdateRepairResult | UpdateRepairTurnResult> {
  const child = spawn(
    process.execPath,
    [path.join(params.target.installRoot, "dist", "infra", "update-repair.worker.js")],
    {
      cwd: params.target.installRoot,
      env: {
        ...process.env,
        NODE_DISABLE_COMPILE_CACHE: "1",
        ...(delegation
          ? delegation.admissionEnv
          : installationTargetEnv({
              stateDir: params.target.stateDir,
              configPath: params.target.configPath,
              defaultWorkspaceDir: params.target.workspaceDir,
            })),
        OPENCLAW_TEST_CONSOLE: "1",
      },
      detached: Boolean(delegation) && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const controller = new AbortController();
  let failure: unknown;
  let result: UpdateRepairResult | UpdateRepairTurnResult | undefined;
  const timer = setTimeout(() => {
    failure = new Error("Repair worker timed out.");
    controller.abort(failure);
    child.kill("SIGKILL");
  }, 90_000);
  for (const [stream, field] of [
    [child.stdout, "stdoutTail"],
    [child.stderr, "stderrTail"],
  ] as const) {
    let tail = Buffer.alloc(0);
    stream?.on("data", (chunk: Buffer) => {
      tail = Buffer.from(Buffer.concat([tail, chunk]).subarray(-16 * 1024));
      diagnostics[field] = tail.toString("utf8");
    });
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0 && result && !failure) {
          resolve(result);
        } else {
          reject(toErrorObject(failure, `Repair worker exited ${code}.`));
        }
      });
      child.on("message", (raw) => {
        void (async () => {
          const message =
            (raw as { type?: unknown }).type === "turn-result"
              ? (raw as Extract<UpdateRepairWorkerMessage, { type: "turn-result" }>)
              : releasedUpdateRepairWorkerMessageSchema.parse(raw);
          if (message.type === "ready") {
            if (delegation) {
              if (delegation.executor !== "unowned" && delegation.executor.bindChild) {
                if (!child.pid) {
                  throw new Error("Repair worker has no PID.");
                }
                delegation.executor.bindChild(child.pid);
              }
              child.send({
                type: "turn",
                runId: delegation.runId,
                executor: delegation.executor === "unowned" ? undefined : delegation.executor.grant,
                requester,
                target: params.target,
                prompt: "Repair the missing marker using the configured tools.",
                wallClockMs: 90_000,
                timeoutMs: 60_000,
                maxToolCalls: 2,
              });
              return;
            }
            // v2026.9.4 sends neither an authority object nor context.phase after
            // activation. The candidate must still accept that shipped message.
            child.send({
              type: "start",
              runId: "released-update-run",
              requester,
              target: params.target,
              failure: { error: params.context.error },
              context: {},
              budget: updateRepairBudgetSchema.parse({ ...params.budget, maxTurns: 1 }),
            });
          } else if (message.type === "validate") {
            const validation = await params.validate(controller.signal);
            child.send({ type: "validation-result", id: message.id, validation });
          } else if (message.type === "result" || message.type === "turn-result") {
            result = message.result;
          }
        })().catch((error: unknown) => {
          failure = error;
          controller.abort(error);
          child.kill("SIGKILL");
        });
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

type ModelRequest = {
  tools?: Array<{ name?: string }>;
};

function writeRepairToolCall(response: ServerResponse, name: "exec" | "write"): void {
  const item = {
    type: "function_call",
    id: `fc_repair_${name}`,
    call_id: `call_repair_${name}`,
    name,
    arguments: JSON.stringify(
      name === "write"
        ? { path: "../outside-repair.txt", content: "must not escape" }
        : {
            command:
              "node -e \"require('node:fs').writeFileSync('repair-proof.txt', [process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION, process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR, process.env.OPENCLAW_SERVICE_REPAIR_POLICY].join(' '))\"",
          },
    ),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_repair_marker",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

type RepairEntry =
  | "released-parent"
  | "manual"
  | "turn"
  | "revoked-turn"
  | "wrong-receiver-turn"
  | "unowned-turn"
  | "unidentified-turn";
it.each([
  "released-parent",
  "manual",
  "turn",
  "revoked-turn",
  "wrong-receiver-turn",
  "unowned-turn",
  "unidentified-turn",
] as const)(
  "preserves released behavior and scopes repair inference (%s)",
  async (entry) => {
    const phase = entry === "turn" ? "validating" : "verifying";
    const diagnostics: RepairDiagnostics = { stdoutTail: "", stderrTail: "" };
    await withOpenClawTestState({ prefix: "update-repair-boundary-", layout: "home" }, (state) =>
      exerciseRepair(state, phase, entry, diagnostics),
    ).catch((error: unknown) => {
      // The E2E runner suppresses console output, including failed cases.
      process.stderr.write(
        `[update-repair-test] diagnostics ${JSON.stringify({ phase, entry, workerStdoutTail: diagnostics.stdoutTail, workerStderrTail: diagnostics.stderrTail })}\n`,
      );
      throw error;
    });
  },
  120_000,
);

async function exerciseRepair(
  state: OpenClawTestState,
  phase: "verifying" | "validating",
  entry: RepairEntry,
  diagnostics: RepairDiagnostics,
) {
  const requests: ModelRequest[] = [];
  const providerCalls: string[] = [];
  const errors: unknown[] = [];
  const issued = { exec: false, write: false };
  await withServer(
    (request, response) => {
      providerCalls.push(`${request.method} ${request.url}`);
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "repair-model", object: "model" }] }));
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(await readText(request)) as ModelRequest;
        requests.push(body);
        for (const name of ["write", "exec"] as const) {
          if (!body.tools?.some((tool) => tool.name === name) || issued[name]) {
            continue;
          }
          issued[name] = true;
          if (name === "exec" && entry === "revoked-turn") {
            // Remove the requester's owner permission while inference is awaiting.
            const current = JSON.parse(await fs.readFile(state.configPath, "utf8"));
            await fs.writeFile(
              state.configPath,
              JSON.stringify({ ...current, commands: { ownerAllowFrom: ["other-owner"] } }),
            );
          }
          writeRepairToolCall(response, name);
          return;
        }
        writeOpenAiResponsesText(response, {
          text: issued.exec
            ? 'REPAIR_RESULT: {"status":"fixed","summary":"Created the target repair marker."}'
            : "OK",
          messageId: `msg_repair_${requests.length}`,
          responseId: `resp_repair_${requests.length}`,
        });
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end();
      });
    },
    async (baseUrl) => {
      const modelRef = "repair-test/repair-model";
      const config: OpenClawConfig = {
        logging: { level: "silent", consoleLevel: "trace" },
        commands: { ownerAllowFrom: ["owner"] },
        plugins: { slots: { memory: "none" } },
        tools: { exec: { mode: "ask", safeBins: ["cat"] }, fs: { workspaceOnly: false } },
        agents: {
          defaults: {
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            systemAgent: { agentId: "operator" },
            skipBootstrap: true,
            skills: [],
            sandbox: { mode: "off" },
          },
          entries: { operator: {} },
        },
        models: {
          mode: "replace",
          providers: {
            "repair-test": {
              baseUrl: `${baseUrl}/v1`,
              apiKey: "synthetic-repair-key",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [repairModel("repair-model", "Repair model", 4096)],
            },
          },
        },
      };
      await state.writeConfig(config);
      const marker = path.join(state.workspaceDir, "repair-proof.txt");
      const targetStateDir = phase === "validating" ? state.path("rehearsal") : state.stateDir;
      const targetConfigPath =
        phase === "validating" ? path.join(targetStateDir, "openclaw.json") : state.configPath;
      if (phase === "validating") {
        await fs.mkdir(targetStateDir, { recursive: true });
        await fs.writeFile(targetConfigPath, JSON.stringify(config));
      }
      const expected = `${targetStateDir} 0 0 external`;
      const ledgerEnv = { ...process.env };
      const run =
        entry === "manual" || entry.endsWith("turn")
          ? createUpdateRun(
              entry === "manual"
                ? { trigger: "cli" }
                : {
                    trigger: "chat",
                    origin: { requester },
                  },
              { env: ledgerEnv },
            )
          : undefined;
      if (run && entry === "manual") {
        finishUpdateRun(
          run.runId,
          { status: "failed", reason: "Synthetic startup failure" },
          { env: ledgerEnv },
        );
      } else if (run) {
        recordUpdateRunPhase(run.runId, "repairing", undefined, { env: ledgerEnv });
      }
      // Delegated turns can target a rehearsal; released parents omit context.phase.
      await fs.symlink(
        path.join(process.cwd(), "dist"),
        path.join(state.workspaceDir, "dist"),
        "dir",
      );
      const params: UpdateRepairParams = {
        isCurrent: run
          ? () => getUpdateRun(run.runId, { env: ledgerEnv })?.status === "failed"
          : undefined,
        target: {
          stateDir: targetStateDir,
          configPath: targetConfigPath,
          workspaceDir: state.workspaceDir,
          installRoot: state.workspaceDir,
        },
        context: { error: "Synthetic repair marker is missing.", phase },
        budget: { wallClockMs: 90_000, perTurnMs: 60_000, maxToolCalls: 2 },
        validate: vi.fn(async () => {
          const text = await fs.readFile(marker, "utf8").catch(() => "");
          const ok = text === expected;
          return {
            ok,
            score: ok ? 1 : 0,
            summary: ok ? "Target marker verified." : "Target marker absent.",
          };
        }),
      };
      const runTurn = async () => {
        if (!run) {
          throw new Error("Delegated repair requires an update run.");
        }
        const control = state.path("executor-control");
        await fs.mkdir(control, { mode: 0o700 });
        const databasePath = path.join(control, "managed-update-handoffs.sqlite");
        const identity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
          captureManagedUpdateLeaseDatabaseIdentity(databasePath),
        );
        return withUpdateCommandExecutor(
          run.runId,
          async (executor) => {
            const fence = await executor.enter(state.workspaceDir);
            return withUpdateCommandExecutorChild(
              fence,
              params.target.installRoot,
              async (grant, bindChild) => {
                const envelope = (receiver?: {
                  grant: UpdateCommandChildGrant;
                  bindChild?: (pid: number) => void;
                }) =>
                  runRepairEnvelope(params, diagnostics, {
                    runId: entry === "unidentified-turn" ? undefined : run.runId,
                    admissionEnv: ledgerEnv,
                    executor: receiver ?? { grant, bindChild },
                  });
                if (entry !== "wrong-receiver-turn") {
                  return envelope();
                }
                const boundReceiver = spawn(
                  process.execPath,
                  ["-e", "setInterval(() => {}, 60_000)"],
                  { stdio: "ignore" },
                );
                const closed = once(boundReceiver, "close");
                if (!boundReceiver.pid) {
                  boundReceiver.kill("SIGKILL");
                  await closed;
                  throw new Error("Bound repair receiver has no PID.");
                }
                // The live grant names this decoy. The worker must reject it
                // before model inference or filesystem effects.
                try {
                  bindChild(boundReceiver.pid);
                  return await envelope({ grant });
                } finally {
                  boundReceiver.kill("SIGKILL");
                  await closed;
                }
              },
            );
          },
          { existingAuthority: { ...identity, installKey: state.workspaceDir } },
        );
      };
      if (entry === "unowned-turn" || entry === "unidentified-turn") {
        if (entry === "unowned-turn" && !run) {
          throw new Error("Unowned repair requires an update run.");
        }
        await expect(
          entry === "unowned-turn"
            ? runRepairEnvelope(params, diagnostics, {
                runId: run?.runId,
                admissionEnv: ledgerEnv,
                executor: "unowned",
              })
            : runTurn(),
        ).rejects.toThrow("worker exited 1");
        expect(requests).toEqual([]);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (entry === "revoked-turn" || entry === "wrong-receiver-turn") {
        const result = await runTurn();
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "aborted",
          ...(entry === "revoked-turn" ? { reason: "requester-revoked" } : {}),
        });
        if (entry === "revoked-turn") {
          expect(issued.exec).toBe(true);
        } else {
          expect(requests).toEqual([]);
        }
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const result =
        entry === "turn"
          ? await runTurn()
          : entry === "released-parent"
            ? await runRepairEnvelope(params, diagnostics)
            : await runUpdateRepairLoop(params);

      expect(errors).toEqual([]);
      if (entry === "released-parent") {
        expect(result).toMatchObject({
          status: "unavailable",
          reason:
            "Inference repair is deferred until after the update has failed. Updates do not require inference.",
          attempts: [],
          finalValidation: { ok: false },
        });
        expect(params.validate).not.toHaveBeenCalled();
        expect(providerCalls).toEqual([]);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.parse(await fs.readFile(targetConfigPath, "utf8"))).toEqual(config);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject(
        entry === "turn"
          ? { status: "completed", toolCalls: 2, summary: "Created the target repair marker." }
          : {
              status: "repaired",
              finalValidation: { ok: true, score: 1 },
              attempts: [{ toolCalls: 2, summary: "Created the target repair marker." }],
            },
      );
      expect(requests.some((body) => body.tools?.some((tool) => tool.name === "exec"))).toBe(true);
      expect(issued.write).toBe(true);
      await expect(
        fs.stat(path.join(state.workspaceDir, "..", "outside-repair.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(marker, "utf8")).toBe(expected);
    },
  );
}
