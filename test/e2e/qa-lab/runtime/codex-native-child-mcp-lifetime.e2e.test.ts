import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  readLatestUserMarker,
  writeOpenAiResponsesItem,
} from "../../../helpers/openai-responses-item.test-support.js";
import { startOpenAiResponsesModelServer } from "../../../helpers/openai-responses-model-fixture.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tmp = useAutoCleanupTempDirTracker(afterEach);
const MODEL = "gpt-5.6-luna";
const MARKER = "SPAWN_CHILD_WITH_MCP_GRANT";
const SESSION = "agent:qa:main";
const POLICY = { allow: ["fixture__get_*"], deny: ["fixture__get_denied"] };
const CHILD_CALLS = [
  { name: "fixture__get_denied", id: "call_denied" },
  { name: "fixture__get_nonce", id: "call_nonce" },
];
const DONE = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Finished." }],
};

// Tool loading can put a function at the root or in a namespace. Never invoke a native
// mcp__ server: the tool under test is the host's fixture__* dynamic projection.
function findFunction(body: Record<string, unknown>, name: string) {
  for (const tool of Array.isArray(body.tools) ? body.tools.filter(isRecord) : []) {
    if (tool.name === name) {
      return { spec: tool, namespace: undefined };
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools) && typeof tool.name === "string") {
      const spec = tool.tools.find((nested) => isRecord(nested) && nested.name === name);
      if (isRecord(spec)) {
        return { spec, namespace: tool.name };
      }
    }
  }
  return undefined;
}

it(
  "retains an admitted child's MCP tool grant, not the completed foreground attempt",
  { timeout: 210_000 },
  async () => {
    const dir = tmp.make("codex-native-child-mcp-");
    const backend = fileURLToPath(new URL("./codex-native-child-mcp.fixture.mjs", import.meta.url));
    const nonce = randomUUID();
    await fs.writeFile(path.join(dir, "nonce"), nonce, { mode: 0o600 });
    const callsFile = path.join(dir, "calls");
    await fs.writeFile(callsFile, "", { mode: 0o600 });
    const childMayCall = createDeferred<boolean>();
    const receipt = {
      policy: POLICY,
      nonceSha256: createHash("sha256").update(nonce).digest("hex"),
      barrier: {
        childAtProvider: false,
        parentSpawnOutput: false,
        parentWaitOk: false,
        parentIdle: false,
      },
      calls: [] as Array<{ name: string; namespace?: string }>,
      outputs: [] as Array<{
        name: string;
        explicitDeny: boolean;
        nonceMatched: boolean;
        outputSha256: string;
      }>,
      backendCalls: [] as string[],
      missing: [] as string[],
    };
    let spawned = false;
    const provider = await startOpenAiResponsesModelServer({
      modelId: MODEL,
      bindError: "MCP lifetime fixture failed to bind",
      async onRequest(req, res) {
        const body: unknown = await json(req);
        if (!isRecord(body) || !Array.isArray(body.input)) {
          res.writeHead(400).end();
          return;
        }
        const child = req.headers["x-openai-subagent"] === "collab_spawn";
        const respond = (item: Record<string, unknown>) =>
          writeOpenAiResponsesItem(res, "resp_" + randomUUID(), item, {
            input_tokens: 32,
            input_tokens_details: null,
            output_tokens: 16,
            output_tokens_details: null,
            total_tokens: 48,
          });
        const parent = !child && readLatestUserMarker(body, [["parent", MARKER]]) === "parent";
        const output = (id: string) =>
          (body.input as unknown[]).find(
            (e) => isRecord(e) && e.type === "function_call_output" && e.call_id === id,
          );
        if (parent && isRecord(output("call_spawn"))) {
          receipt.barrier.parentSpawnOutput = true;
          respond(DONE);
          return;
        }
        if (child) {
          receipt.barrier.childAtProvider = true;
          // No response containing child tool calls can leave the provider before BOTH Gateway
          // observations below. A final model response on the parent socket is not a run-end fence.
          if (!(await childMayCall.promise)) {
            respond(DONE);
            return;
          }
          for (const call of CHILD_CALLS) {
            const entry = output(call.id);
            if (!isRecord(entry) || receipt.outputs.some((seen) => seen.name === call.name)) {
              continue;
            }
            const payload = JSON.stringify(entry.output);
            receipt.outputs.push({
              name: call.name,
              explicitDeny: payload.includes("Excluded by nativeChildTools.deny."),
              nonceMatched: payload.includes(nonce),
              outputSha256: createHash("sha256").update(payload).digest("hex"),
            });
          }
        }
        const call = child
          ? CHILD_CALLS.find(({ name }) => !receipt.outputs.some((seen) => seen.name === name))
          : parent && !spawned
            ? { name: "spawn_agent", id: "call_spawn" }
            : undefined;
        if (!call || (child && receipt.calls.some((seen) => seen.name === call.name))) {
          respond(DONE);
          return;
        }
        const tool = findFunction(body, call.name);
        if (
          !tool ||
          (child &&
            tool.namespace &&
            !["openclaw", "openclaw_direct", "functions"].includes(tool.namespace))
        ) {
          receipt.missing.push(call.name);
          respond(DONE);
          return;
        }
        const { parameters } = tool.spec;
        const args = child
          ? {}
          : {
              ...(isRecord(parameters) &&
              isRecord(parameters.properties) &&
              parameters.properties.task_name
                ? { task_name: "reader" }
                : {}),
              message: "Read the harmless fixture receipt.",
            };
        if (child) {
          receipt.calls.push({
            name: call.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
          });
        } else {
          spawned = true;
        }
        respond({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify(args),
        });
      },
    });
    const owner = createQaGatewayChild();
    try {
      await runQaGatewayFixture(
        async () => {
          const gateway = await owner.start({
            repoRoot: process.cwd(),
            command: {
              executablePath: process.execPath,
              argsPrefix: ["dist/index.js"],
              cwd: process.cwd(),
              usePackagedPlugins: true,
            },
            transportBaseUrl: "http://127.0.0.1",
            providerMode: "mock-openai",
            providerBaseUrl: provider.baseUrl + "/v1",
            forcedRuntime: "codex",
            codexMockNativeSubagents: true,
            runtimeSelection: "configured",
            primaryModel: "mock-openai/" + MODEL,
            alternateModel: "mock-openai/" + MODEL,
            enabledPluginIds: ["codex"],
            controlUiEnabled: false,
            mutateConfig(config) {
              delete config.plugins!.entries!["qa-lab"];
              config.plugins!.allow = config.plugins!.allow?.filter((id) => id !== "qa-lab");
              const codex = config.plugins!.entries!.codex!;
              codex.config = {
                ...codex.config,
                codexDynamicToolsLoading: "direct",
                nativeChildTools: POLICY,
              };
              // Project static MCP through the host instead of allowing Codex-native MCP.
              // There is no node and the fixture never requests shell or filesystem execution.
              config.tools = { ...config.tools, exec: { ...config.tools?.exec, host: "node" } };
              config.mcp = {
                servers: { fixture: { command: process.execPath, args: [backend, dir] } },
              };
              return config;
            },
          });
          const runId = randomUUID();
          const started = await gateway.call("chat.send", {
            sessionKey: SESSION,
            message: MARKER,
            deliver: false,
            idempotencyKey: runId,
          });
          expect(started).toMatchObject({ runId, status: "started" });
          await expect
            .poll(
              () =>
                receipt.missing.length
                  ? receipt.missing
                  : receipt.barrier.childAtProvider && receipt.barrier.parentSpawnOutput,
              { timeout: 50_000 },
            )
            .toBe(true);
          await expect
            .poll(() => gateway.call("agent.wait", { runId, timeoutMs: 2_000 }), {
              timeout: 30_000,
            })
            .toMatchObject({ runId, status: "ok" });
          receipt.barrier.parentWaitOk = true;
          await expect
            .poll(() => gateway.call("sessions.describe", { key: SESSION }), { timeout: 30_000 })
            .toMatchObject({ session: { key: SESSION, hasActiveRun: false, activeRunIds: [] } });
          receipt.barrier.parentIdle = true;
          expect(receipt.calls).toEqual([]);
          expect(await fs.readFile(callsFile, "utf8")).toBe("");
          childMayCall.resolve(true);
          await expect
            .poll(() => (receipt.missing.length ? receipt.missing : receipt.outputs.length), {
              timeout: 50_000,
            })
            .toBe(2);
          expect(receipt.outputs).toMatchObject([
            { name: "fixture__get_denied", explicitDeny: true, nonceMatched: false },
            { name: "fixture__get_nonce", explicitDeny: false, nonceMatched: true },
          ]);
          expect(await fs.readFile(callsFile, "utf8")).toBe("get_nonce\n");
        },
        () => childMayCall.resolve(false),
        () => stopQaGatewayFixture(owner),
        provider.close,
      );
    } finally {
      receipt.backendCalls = (await fs.readFile(callsFile, "utf8")).split("\n").filter(Boolean);
      // Optional public-safe receipt: fixture names, predicates and digests only, never inputs,
      // transcripts, identifiers, nonce plaintext or credentials. Written on failure as well.
      const out = process.env.OPENCLAW_PRPROOF_MCP_RECEIPT;
      if (out) {
        await fs.writeFile(out, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      }
    }
  },
);
