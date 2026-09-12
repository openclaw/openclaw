import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { prepareUnattendedUpdateRepair, runUpdateRepairLoop } from "./update-repair-agent.js";
import {
  updateRepairBudgetSchema,
  updateRepairWorkerMessageSchema,
  type UpdateRepairParams,
  type UpdateRepairResult,
} from "./update-repair-protocol.js";
import { withRepairExecutor } from "./update-repair.test-support.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

// Manual triage retains the shared in-process loop. Load its built runtime through
// Node's loader, as the CLI does; worker cases already use the packaged child.
vi.mock("./update-repair-agent.runtime.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(
    "../../dist/update-repair-agent.runtime.js",
  ) as typeof import("./update-repair-agent.runtime.js");
});

async function runWorkerEnvelope(
  params: UpdateRepairParams,
  mode: "released-parent" | "unowned-turn" | "unidentified-turn" = "released-parent",
): Promise<UpdateRepairResult> {
  const child = spawn(
    process.execPath,
    [path.join(params.target.installRoot, "dist", "infra", "update-repair.worker.js")],
    {
      cwd: params.target.installRoot,
      env: {
        ...process.env,
        NODE_DISABLE_COMPILE_CACHE: "1",
        ...installationTargetEnv({
          stateDir: params.target.stateDir,
          configPath: params.target.configPath,
          defaultWorkspaceDir: params.target.workspaceDir,
        }),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const controller = new AbortController();
  let failure: unknown;
  let result: UpdateRepairResult | undefined;
  const timer = setTimeout(() => {
    failure = new Error("Repair worker timed out.");
    controller.abort(failure);
    child.kill("SIGKILL");
  }, 90_000);
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
          const message = updateRepairWorkerMessageSchema.parse(raw);
          if (message.type === "ready") {
            const {
              phase: _phase,
              beforeVersion,
              targetVersion,
              symptoms,
              ...context
            } = params.context;
            // v2026.9.4 sends neither an authority object nor context.phase after
            // activation. Replaying that shipped message must retain worker repair.
            child.send({
              type: "start",
              runId: mode === "unidentified-turn" ? undefined : params.runId,
              requester: params.requester,
              ...(mode === "released-parent"
                ? {}
                : {
                    turn: {
                      prompt: "Repair the synthetic marker using the configured tools.",
                      timeoutMs: 60000,
                      maxToolCalls: 2,
                    },
                  }),
              target: params.target,
              failure: context,
              context: { beforeVersion, targetVersion, symptoms },
              budget: updateRepairBudgetSchema.parse(params.budget),
            });
          } else if (message.type === "validate") {
            const validation = await params.validate(controller.signal);
            child.send({ type: "validation-result", id: message.id, validation });
          } else if (message.type === "result") {
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
  model?: string;
  tools?: Array<{ name?: string }>;
  input?: Array<{ type?: string; call_id?: string; output?: string }>;
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

describe("update repair with a local model provider", () => {
  it.each([
    { phase: "validating", revoke: "none", entry: "worker" },
    { phase: "verifying", revoke: "none", entry: "worker" },
    { phase: "validating", revoke: "requester", entry: "worker" },
    { phase: "validating", revoke: "run", entry: "worker" },
    { phase: "verifying", revoke: "none", entry: "released-parent" },
    { phase: "verifying", revoke: "none", entry: "manual" },
    { phase: "verifying", revoke: "none", entry: "unowned-turn" },
    { phase: "verifying", revoke: "none", entry: "unidentified-turn" },
  ] as const)(
    "checks repair scope before host exec during $phase ($entry, $revoke)",
    async ({ phase, revoke, entry }) => {
      await withOpenClawTestState(
        { prefix: "update-repair-boundary-", layout: "home" },
        async (state) => {
          const requests: ModelRequest[] = [];
          const errors: unknown[] = [];
          let issuedRepair = false;
          let issuedScopeProbe = false;
          let revokeAuthority = async () => {};
          await withServer(
            (request, response) => {
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
                if (body.tools?.some((tool) => tool.name === "write") && !issuedScopeProbe) {
                  issuedScopeProbe = true;
                  writeRepairToolCall(response, "write");
                  return;
                }
                if (body.tools?.some((tool) => tool.name === "exec") && !issuedRepair) {
                  issuedRepair = true;
                  // Revoke after inference begins but before its tool effect is dispatched.
                  await revokeAuthority();
                  writeRepairToolCall(response, "exec");
                  return;
                }
                writeOpenAiResponsesText(response, {
                  text: issuedRepair
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
                      models: [
                        {
                          id: "repair-model",
                          name: "Repair model",
                          reasoning: false,
                          input: ["text"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 128_000,
                          maxTokens: 4_096,
                        },
                      ],
                    },
                  },
                },
              };
              await state.writeConfig(config);
              const marker = path.join(state.workspaceDir, "repair-proof.txt");
              const targetStateDir =
                phase === "validating" ? state.path("rehearsal") : state.stateDir;
              const targetConfigPath =
                phase === "validating"
                  ? path.join(targetStateDir, "openclaw.json")
                  : state.configPath;
              if (phase === "validating") {
                await fs.mkdir(targetStateDir, { recursive: true });
                await fs.writeFile(targetConfigPath, JSON.stringify(config));
              }
              const expected = `${targetStateDir} 0 0 external`;
              const ledgerEnv = { ...process.env };
              const run = createUpdateRun({ trigger: "cli" }, { env: ledgerEnv });
              recordUpdateRunPhase(run.runId, "repairing", undefined, { env: ledgerEnv });
              revokeAuthority = async () => {
                if (revoke === "requester") {
                  await state.writeConfig({
                    ...config,
                    commands: { ownerAllowFrom: ["different-owner"] },
                  });
                } else if (revoke === "run") {
                  recordUpdateRunPhase(run.runId, "verifying", undefined, { env: ledgerEnv });
                }
              };
              // The rehearsal has no live run ledger; authorization must use the source.
              // Both phases host repair in the installation that owns the target state.
              await fs.symlink(
                path.join(process.cwd(), "dist"),
                path.join(state.workspaceDir, "dist"),
                "dir",
              );
              const params: UpdateRepairParams = {
                runId: run.runId,
                requester: { channel: "synthetic", senderId: "owner" },
                admissionEnv: ledgerEnv,
                isCurrent: () => getUpdateRun(run.runId, { env: ledgerEnv })?.status === "running",
                target: {
                  stateDir: targetStateDir,
                  configPath: targetConfigPath,
                  workspaceDir: state.workspaceDir,
                  installRoot: state.workspaceDir,
                },
                context: { error: "Synthetic repair marker is missing.", phase },
                budget: { maxTurns: 1, wallClockMs: 90_000, perTurnMs: 60_000, maxToolCalls: 2 },
                validate: async () => {
                  const text = await fs.readFile(marker, "utf8").catch(() => "");
                  const ok = text === expected;
                  return {
                    ok,
                    score: ok ? 1 : 0,
                    summary: ok ? "Target marker verified." : "Target marker absent.",
                  };
                },
              };
              if (entry === "unowned-turn" || entry === "unidentified-turn") {
                await expect(runWorkerEnvelope(params, entry)).rejects.toThrow(
                  "Repair worker exited 1.",
                );
                expect(requests).toEqual([]);
                await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
                return;
              }
              const result =
                entry === "released-parent"
                  ? await runWorkerEnvelope(params)
                  : entry === "manual"
                    ? await runUpdateRepairLoop(params)
                    : await withRepairExecutor(params, prepareUnattendedUpdateRepair);

              expect(errors).toEqual([]);
              if (revoke !== "none") {
                expect(issuedRepair).toBe(true);
                expect(result, JSON.stringify(result)).toMatchObject({ status: "aborted" });
                await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
                if (phase === "validating") {
                  expect(
                    JSON.parse(await fs.readFile(targetConfigPath, "utf8")).commands.ownerAllowFrom,
                  ).toEqual(["owner"]);
                }
                return;
              }
              expect(result, JSON.stringify(result)).toMatchObject({
                status: "repaired",
                finalValidation: { ok: true, score: 1 },
                attempts: [{ toolCalls: 2, summary: "Created the target repair marker." }],
              });
              expect(
                requests.some((body) => body.tools?.some((tool) => tool.name === "exec")),
              ).toBe(true);
              expect(issuedScopeProbe).toBe(true);
              await expect(
                fs.stat(path.join(state.workspaceDir, "..", "outside-repair.txt")),
              ).rejects.toMatchObject({ code: "ENOENT" });
              expect(await fs.readFile(marker, "utf8")).toBe(expected);
            },
          );
        },
      );
    },
    120_000,
  );
});
