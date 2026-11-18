import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readText } from "node:stream/consumers";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { createOpenAiResponsesModelConfig } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeToolCallResponse } from "../gateway/gateway-provider-fixture.test-support.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { updateRepairWorkerMessageSchema as releasedUpdateRepairWorkerMessageSchema } from "./test-fixtures/update-repair-protocol.v2026-9-4.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import {
  updateRepairBudgetSchema,
  type UpdateRepairParams,
  type UpdateRepairResult,
} from "./update-repair-protocol.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";

// Manual triage retains the shared in-process loop. Load its built runtime through
// Node's loader, as the CLI does; worker cases already use the packaged child.
vi.mock("./update-repair-agent.runtime.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(
    "../../dist/update-repair-agent.runtime.js",
  ) as typeof import("./update-repair-agent.runtime.js");
});

const requester = { channel: "synthetic", senderId: "owner" };
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

async function runRepairEnvelope(params: UpdateRepairParams): Promise<UpdateRepairResult> {
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
        OPENCLAW_TEST_CONSOLE: "1",
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  let failure: Error | undefined;
  let result: UpdateRepairResult | undefined;
  const closed = once(child, "close");
  const timer = setTimeout(() => {
    failure = new Error("Repair worker timed out.");
    child.kill("SIGKILL");
  }, 90_000);
  try {
    child.on("message", (raw) => {
      try {
        const message = releasedUpdateRepairWorkerMessageSchema.parse(raw);
        if (message.type === "ready") {
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
        } else if (message.type === "result") {
          result = message.result;
        }
      } catch (error) {
        failure = toErrorObject(error, "Repair worker failed.");
        child.kill("SIGKILL");
      }
    });
    const [code] = await closed;
    if (failure) {
      throw failure;
    }
    if (code !== 0 || !result) {
      throw new Error(`Repair worker exited ${code}.`);
    }
    return result;
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
  writeToolCallResponse(response, item, "resp_repair_marker", 10, 10);
}

const repairEntries = ["released-parent", "manual"] as const;
type RepairEntry = (typeof repairEntries)[number];
it.each(repairEntries)(
  "preserves released behavior and scopes repair inference (%s)",
  async (entry) => {
    await withOpenClawTestState({ prefix: "update-repair-boundary-", layout: "home" }, (state) =>
      exerciseRepair(state, entry),
    );
  },
  120_000,
);

async function exerciseRepair(state: OpenClawTestState, entry: RepairEntry) {
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
      const modelConfig = createOpenAiResponsesModelConfig({
        baseUrl,
        providerId: "repair-test",
        modelId: "repair-model",
        reasoning: false,
        toolProfile: "coding",
      });
      const config: OpenClawConfig = {
        ...modelConfig,
        logging: { level: "silent", consoleLevel: "trace" },
        commands: { ownerAllowFrom: ["owner"] },
        plugins: { slots: { memory: "none" } },
        tools: { exec: { mode: "ask", safeBins: ["cat"] }, fs: { workspaceOnly: false } },
        agents: {
          ...modelConfig.agents,
          defaults: {
            ...modelConfig.agents?.defaults,
            systemAgent: { agentId: "operator" },
            sandbox: { mode: "off" },
          },
          entries: { operator: {} },
        },
      };
      await state.writeConfig(config);
      const marker = path.join(state.workspaceDir, "repair-proof.txt");
      const expected = `${state.stateDir} 0 0 external`;
      const ledgerEnv = { ...process.env };
      const run =
        entry === "manual" ? createUpdateRun({ trigger: "cli" }, { env: ledgerEnv }) : undefined;
      if (run) {
        finishUpdateRun(
          run.runId,
          { status: "failed", reason: "Synthetic startup failure" },
          { env: ledgerEnv },
        );
      }
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
          stateDir: state.stateDir,
          configPath: state.configPath,
          workspaceDir: state.workspaceDir,
          installRoot: state.workspaceDir,
        },
        context: { error: "Synthetic repair marker is missing.", phase: "verifying" },
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
      const result =
        entry === "released-parent"
          ? await runRepairEnvelope(params)
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
        await expectMissing(marker);
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "repaired",
        finalValidation: { ok: true, score: 1 },
        attempts: [{ toolCalls: 2, summary: "Created the target repair marker." }],
      });
      expect(requests.some((body) => body.tools?.some((tool) => tool.name === "exec"))).toBe(true);
      expect(issued.write).toBe(true);
      await expectMissing(path.join(state.workspaceDir, "..", "outside-repair.txt"));
      expect(await fs.readFile(marker, "utf8")).toBe(expected);
    },
  );
}
