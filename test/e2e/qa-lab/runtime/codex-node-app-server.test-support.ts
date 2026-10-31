import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listMockCodexModelInfos } from "../../../../extensions/qa-lab/api.js";
import { fixtureReceiptClientSource } from "../../../helpers/fixture-receipts.js";
import {
  writeOpenAiResponsesItem,
  readLatestUserMarker,
} from "../../../helpers/openai-responses-item.test-support.js";
import { closeWireServer } from "./paired-node-worker-wire-fixture.js";

export const MODEL_ID = "gpt-5.6-luna";
export const MODEL_REF = `openai/${MODEL_ID}`;
export const MARKERS = {
  first: "P8_WORKER_FIRST",
  second: "P8_WORKER_SECOND",
  cancel: "P8_WORKER_CANCEL",
  forbidden: "P8_WORKER_FORBIDDEN",
  revoked: "P8_WORKER_REVOKED",
} as const;
export type Scenario = keyof typeof MARKERS;
export const GATEWAY_BEARER = "p8-gateway-synthetic-decoy";
const WORKER_BEARER = "p8-worker-synthetic-bearer";

function nativeCommand(scenario: Scenario, receiptEndpoint: string): string {
  const source = [
    'import fs from "node:fs";',
    fixtureReceiptClientSource(receiptEndpoint),
    "const evidence = { pid: process.pid, cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME,",
    "providerKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),",
    "forgeTokenPresent: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),",
    "gatewayTokenPresent: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),",
    "runtimeInjectionPresent: Boolean(process.env.NODE_OPTIONS) };",
    `fs.writeFileSync(${JSON.stringify(`p8-${scenario}.json`)},JSON.stringify(evidence));`,
    `sendReceipt(${JSON.stringify(MARKERS[scenario])}, "started");`,
    scenario === "cancel"
      ? `await awaitRelease(${JSON.stringify(MARKERS.cancel)}, "never-released");`
      : `console.log(${JSON.stringify(`${MARKERS[scenario]}_NATIVE_OK`)});`,
  ].join("\n");
  // Base64 avoids shell interpolation of fixture source; this is the model's
  // native exec_command, not an RPC command/exec substitute.
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return `node --input-type=module -e 'await import(${JSON.stringify(moduleUrl)})'`;
}

export async function startWorkerResponses(receiptEndpoint: string) {
  const catalogRequests: Array<{
    kind: string;
    gatewayAuth: boolean;
    carrier: string;
    runtime: string;
  }> = [];
  const requests: Array<{
    scenario?: Scenario;
    workerAuth: boolean;
    model: unknown;
    tools: string[];
    completed: boolean;
  }> = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method === "GET" &&
        ["/platform/models", "/platform/access-programs"].includes(request.url ?? "")
      ) {
        const kind = request.url === "/platform/models" ? "models" : "access-programs";
        const gatewayAuth = request.headers.authorization === "Bearer " + GATEWAY_BEARER;
        catalogRequests.push({
          kind,
          gatewayAuth,
          carrier: String(request.headers["x-p8-catalog-carrier"] ?? ""),
          runtime: String(request.headers["x-p8-catalog-runtime"] ?? ""),
        });
        const body = !gatewayAuth
          ? { error: { message: "Synthetic catalog credential rejected" } }
          : kind === "models"
            ? { object: "list", data: [{ id: MODEL_ID, object: "model" }] }
            : { models: [] };
        response.writeHead(gatewayAuth ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body)) {
        throw new Error("Responses request was not an object");
      }
      const scenario = readLatestUserMarker(body, Object.entries(MARKERS) as [Scenario, string][]);
      const callId = `p8-native-${scenario}`;
      const completed = (Array.isArray(body.input) ? body.input : []).some(
        (item) => isRecord(item) && item.type === "function_call_output" && item.call_id === callId,
      );
      const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
        isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
      );
      const workerAuth = request.headers.authorization === `Bearer ${WORKER_BEARER}`;
      requests.push({ scenario, workerAuth, model: body.model, tools, completed });
      if (!scenario || !workerAuth) {
        // A local fallback, prepared Gateway profile, or lost user turn must not
        // receive a success-shaped response from this fixture.
        response.writeHead(403).end("Expected worker command-auth and a P8 user turn");
        return;
      }
      if (completed) {
        writeOpenAiResponsesItem(response, `resp_p8_${randomUUID()}`, {
          type: "message",
          role: "assistant",
          id: `msg_${scenario}`,
          content: [{ type: "output_text", text: `${MARKERS[scenario]}_OK` }],
        });
      } else {
        writeOpenAiResponsesItem(response, `resp_p8_${randomUUID()}`, {
          type: "function_call",
          call_id: callId,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: nativeCommand(scenario, receiptEndpoint),
            yield_time_ms: 30_000,
            max_output_tokens: 1_000,
          }),
        });
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("Synthetic worker provider failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    catalogRequests,
    errors,
    close: () => closeWireServer(server),
  };
}

/** Synthetic operator provisioning, not the cloud enrollment/bootstrap proof. */
export async function stageWorkerCodex(params: {
  root: string;
  nodeState: string;
  providerBaseUrl: string;
  receiptEndpoint?: string;
}) {
  const sourceHome = path.join(params.root, "source-codex");
  const workerHome = path.join(params.nodeState, "codex-runtime");
  const observations = path.join(params.root, "auth-observations");
  const authGate = path.join(params.root, "auth-effect-gate");
  await Promise.all(
    [sourceHome, workerHome, observations].map((dir) =>
      fs.mkdir(dir, { recursive: true, mode: 0o700 }),
    ),
  );
  const catalogPath = path.join(sourceHome, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({ models: listMockCodexModelInfos([MODEL_REF]) }),
    { mode: 0o600 },
  );
  const sourceHelper = path.join(sourceHome, "token.mjs");
  const workerHelper = path.join(workerHome, "token.mjs");
  const helper = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    ...(params.receiptEndpoint ? [fixtureReceiptClientSource(params.receiptEndpoint)] : []),
    `const worker = fileURLToPath(import.meta.url) === ${JSON.stringify(workerHelper)};`,
    "if (worker) {",
    `const gate = fs.existsSync(${JSON.stringify(authGate)}) ? fs.readFileSync(${JSON.stringify(authGate)}, "utf8").trim() : undefined;`,
    'const parentArgs = fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\\0");',
    'const status = fs.readFileSync(`/proc/${process.ppid}/status`, "utf8");',
    "const nodePid = Number(status.match(/^PPid:\\s+(\\d+)/m)?.[1]);",
    'const nativePids = fs.readFileSync(`/proc/${nodePid}/task/${nodePid}/children`, "utf8").trim().split(/\\s+/).map(Number).filter(pid => { try { const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\\0"); return args.includes("app-server") || args.includes("exec-server"); } catch { return false; } });',
    'const evidence = { nativePids, startedAt: Date.now(), helperPid: process.pid, gate, appServerPid: process.ppid, nodePid, parentAppServer: parentArgs.includes("app-server"), executable: fs.readlinkSync(`/proc/${process.ppid}/exe`), home: process.env.HOME, codexHome: process.env.CODEX_HOME };',
    `fs.writeFileSync(path.join(${JSON.stringify(observations)}, process.pid + ".json"), JSON.stringify(evidence), { mode: 0o600 });`,
    ...(params.receiptEndpoint
      ? [
          'if (gate) { sendReceipt(gate, "held-before-token"); await awaitRelease(gate, "continue"); sendReceipt(gate, "released"); }',
        ]
      : []),
    "}",
    `process.stdout.write((worker ? ${JSON.stringify(WORKER_BEARER)} : "p8-gateway-synthetic-bearer") + "\\n");`,
  ].join("\n");
  const config = [
    `model = ${JSON.stringify(MODEL_ID)}`,
    'model_provider = "p8-fixture"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.p8-fixture]",
    'name = "P8 synthetic worker"',
    `base_url = ${JSON.stringify(`${params.providerBaseUrl}/v1`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "[model_providers.p8-fixture.auth]",
    'command = "node"',
    `args = [${JSON.stringify(sourceHelper)}]`,
    "",
  ].join("\n");
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        "codex-worker-provisioning-v1",
        config.replace(sourceHelper, path.basename(sourceHelper)),
        helper,
      ]),
    )
    .digest("hex");
  const sourceConfig = path.join(sourceHome, "config.toml");
  await fs.writeFile(sourceConfig, config, { mode: 0o600 });
  await fs.writeFile(sourceHelper, helper, { mode: 0o600 });
  await fs.writeFile(workerHelper, helper, { mode: 0o600 });
  await fs.writeFile(
    path.join(workerHome, "config.toml"),
    config.replace(sourceHelper, workerHelper),
    { mode: 0o600 },
  );
  // Publish the version only after both private inputs exist, as enrollment does.
  await fs.writeFile(path.join(workerHome, "version"), version, { mode: 0o600 });
  return {
    sourceHome,
    sourceConfig,
    sourceHelper,
    workerHome,
    observations,
    authGate,
    version,
    command: `codex.app-server.stdio.v1.${version}`,
  };
}
