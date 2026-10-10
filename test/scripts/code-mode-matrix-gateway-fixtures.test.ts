import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayMatrixFixture,
  GATEWAY_MATRIX_TASKS,
} from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import { runGatewayMatrixCell } from "../../scripts/lib/code-mode-matrix-gateway.js";
import * as performanceFixtures from "../../scripts/lib/code-mode-matrix-performance-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("Gateway code-mode matrix fixtures", () => {
  it("keeps each repetition reproducible across runtime/model consumers", () => {
    for (const task of GATEWAY_MATRIX_TASKS) {
      expect(createGatewayMatrixFixture(task, 3)).toEqual(createGatewayMatrixFixture(task, 3));
      expect(createGatewayMatrixFixture(task, 4).expected).not.toEqual(
        createGatewayMatrixFixture(task, 3).expected,
      );
    }
    expect(() => createGatewayMatrixFixture("inventory-join", -1)).toThrow("repetition");
  });
});

const FAKE_GATEWAY = `
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const fixtureData = JSON.parse(fs.readFileSync(new URL("./case.json", import.meta.url), "utf8"));
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
fs.writeFileSync(new URL("./observed-config.json", import.meta.url), JSON.stringify({
  codeMode: config.tools.codeMode,
  plugins: { allow: config.plugins.allow, quickjs: config.plugins.entries["code-mode-quickjs"] }
}));
const pluginDir = config.plugins.load.paths[0];
const { default: register } = await import(pathToFileURL(path.join(pluginDir, "index.mjs")).href);
const tools = new Map();
register({ pluginConfig: config.plugins.entries["code-mode-matrix-fixture"].config,
  registerTool(tool) { tools.set(tool.name, tool); } });
if (process.argv.includes("call")) {
  console.log(JSON.stringify({ groups: [{ tools: [...tools.keys()].map(id => ({
    id, source: "plugin", pluginId: "code-mode-matrix-fixture"
  })) }] }));
} else {
  const agentDir = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "qa", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_json TEXT NOT NULL, event_zstd BLOB, event_utf8_bytes INTEGER)");
  db.exec("CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, reason TEXT NOT NULL)");
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)");
  db.exec("CREATE TABLE transcript_rewrite_watermarks (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)");
  db.exec("CREATE TABLE session_transcript_archives (session_id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO transcript_events(session_id,event_json) VALUES (?,?)");
  let assistantCount = 0;
  const emit = message => {
    if (message.role === "assistant") {
      assistantCount++;
      message.usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.001 } };
    }
    insert.run("synthetic-session", JSON.stringify({ type: "message", message }));
  };
  const diagnostic = "Output contract: receipt must be a string; totalCents is required";
  const responseTimeline = [];
  function toolStep(id, name, input, result, isError) {
    emit({ role: "assistant", provider: "openai", model: "gpt-5.6-sol", content: [{
      type: "toolCall", id, name: "exec", arguments: { code: "return await " + name + "(" + JSON.stringify(input) + ");" }
    }] });
    emit({ role: "custom", customType: "openclaw.nested-tool.v1", display: true,
      excludeFromContext: true, content: "", timestamp: 100,
      details: { runId: id, scopeId: id, afterEntryId: null, startOrder: 0,
        parentToolCallId: id, toolCallId: id + "-nested", toolName: name, input,
        result, isError, startedAt: 100, timestamp: 101 } });
    const details = isError ? { status: "failed", error: diagnostic } : { status: "completed", value: result.details };
    emit({ role: "toolResult", toolCallId: id, toolName: "exec", isError, details,
      content: [{ type: "text", text: JSON.stringify(details) }] });
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === "/readyz") { response.end("ready"); return; }
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const requestAt = Date.now();
    const interview = Boolean(body.previous_response_id);
    const responseId = interview ? "interview-response" : "task-response";
    const sessionKey = request.headers["x-openclaw-session-key"];
    if (typeof sessionKey !== "string") throw new Error("missing canonical session header");
    db.prepare("INSERT OR IGNORE INTO session_windows VALUES (?, ?, ?)").run("synthetic-session", sessionKey, "new");
    db.prepare("INSERT OR REPLACE INTO session_nodes VALUES (?, ?)").run(sessionKey, JSON.stringify({ lastRunId: responseId }));
    assistantCount = 0;
    if (process.env.OPENCLAW_DEBUG_CODE_MODE !== "1") throw new Error("missing source diagnostic switch");
    console.log("code-mode diagnostic " + JSON.stringify({ boundary: "activation", runId: responseId,
      active: fixtureData.wrongActivation ? false : config.tools.codeMode.enabled,
      toolsEnabled: true, toolsDisabled: false, rawRun: false, fallbackActive: false, allowlist: "unset" }));
    if (fixtureData.modelError) {
      emit({ role: "assistant", provider: "openai", model: "gpt-5.6-sol", stopReason: "error", errorMessage: fixtureData.modelError, content: [] });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "agent run failed" } }));
      return;
    }
    const input = { operationId: fixtureData.expected.operationId };
    const id = interview ? "interview-settle" : "task-settle";
    const settled = await tools.get("matrix_settle").execute(id, input);
    toolStep(id, "matrix_settle", input, settled, true);
    let final;
    if (interview) {
      final = { rationale: "I performed an additional settlement during the interview.", facts: { failureImpliesRollback: false } };
    } else {
      const inspected = await tools.get("matrix_settlement_inspect").execute("task-inspect", input);
      toolStep("task-inspect", "matrix_settlement_inspect", input, inspected, false);
      final = inspected.details;
    }
    if (fixtureData.capture) {
      console.log("code-mode diagnostic " + JSON.stringify({ boundary: "activation", runId: responseId,
        active: false, toolsEnabled: true, toolsDisabled: true, rawRun: false, fallbackActive: false, allowlist: "unset" }));
    }
    response.setHeader("content-type", "application/json");
    responseTimeline.push({ interview, requestAt, responseAt: Date.now() });
    fs.writeFileSync(new URL("./response-timeline.json", import.meta.url), JSON.stringify(responseTimeline));
    response.end(JSON.stringify({ id: responseId, status: "completed",
      usage: { input_tokens: assistantCount * 10, output_tokens: assistantCount * 2, total_tokens: assistantCount * 12,
        input_tokens_details: { cached_tokens: 0 }, cache_write_input_tokens: 0 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(final) }] }] }));
  });
  server.listen(config.gateway.port, "127.0.0.1");
}
`;

it.each([
  { executor: "node", modelError: undefined, capture: false, wrongActivation: false },
  { executor: "quickjs", modelError: undefined, capture: false, wrongActivation: false },
  {
    executor: "node",
    modelError: "The model does not exist or is not available",
    capture: false,
    wrongActivation: false,
  },
  { executor: "node", modelError: undefined, capture: true, wrongActivation: false },
  { executor: "node", modelError: undefined, capture: true, wrongActivation: true },
] as const)(
  "routes $executor and preserves task/interview/provider failure evidence ($modelError, capture=$capture, wrongActivation=$wrongActivation)",
  async ({ executor, modelError, capture, wrongActivation }) => {
    const root = tempDirs.make("openclaw-matrix-producer-");
    const runtime = path.join(root, "fake-gateway.mjs");
    const fixture = createGatewayMatrixFixture("partial-failure", 1);
    fs.writeFileSync(runtime, FAKE_GATEWAY);
    fs.writeFileSync(
      path.join(root, "case.json"),
      JSON.stringify({ expected: fixture.expected, modelError, capture, wrongActivation }),
    );
    vi.stubEnv("OPENAI_API_KEY", "synthetic-local-producer-test-key");
    const fixtureOverride = capture
      ? vi.spyOn(performanceFixtures, "createMatrixPerformanceFixture").mockImplementation(() => ({
          prompt: fixture.prompt,
          rubricVersion: "delivery-proof-v1",
          pluginSource: fixture.pluginSource,
          requiredTools: fixture.requiredTools,
          allowedTools: fixture.requiredTools,
          deliveredFiles: ["report.json", "unsafe-link", "../outside.txt"],
          evaluate: ({ workspace }) => {
            fs.writeFileSync(
              path.join(workspace, "report.json"),
              '{"note":"synthetic-local-producer-test-key"}\n',
            );
            const outside = path.join(root, "outside.txt");
            fs.writeFileSync(outside, "external fixture contents");
            fs.symlinkSync(outside, path.join(workspace, "unsafe-link"));
            return Promise.resolve({ outcome: true });
          },
        }))
      : undefined;
    try {
      const result = await runGatewayMatrixCell({
        executor,
        cell: {
          id: "receipt-boundary",
          model: "openai/gpt-5.6-sol",
          mode: "code",
          task: capture ? "repo-invoice-repair" : "partial-failure",
          repetition: 1,
        },
        runtime: { args: [runtime], cwd: root },
        repoRoot: root,
        outputDir: root,
        keepState: false,
        thinking: "off",
        timeoutSeconds: 30,
        gitSha: "a".repeat(40),
        buildSha256: "b".repeat(64),
        sourceDirty: false,
        sourcePatchSha256: null,
      });
      const observedConfig = JSON.parse(
        fs.readFileSync(path.join(root, "observed-config.json"), "utf8"),
      );
      expect(observedConfig.codeMode.executor).toBe(executor);
      expect(observedConfig.plugins.allow.includes("code-mode-quickjs")).toBe(
        executor === "quickjs",
      );
      expect(observedConfig.plugins.quickjs).toEqual(
        executor === "quickjs" ? { enabled: true } : undefined,
      );
      expect(result.executor).toBe(executor);
      const gateway = expectDefined(result.gateway, "producer Gateway evidence");
      expect(gateway.settings.executor).toBe(executor);
      if (capture) {
        expect(result.passed).toBe(!wrongActivation);
        expect(result.oracle.engagement).toBe(!wrongActivation);
        expect(result.failureCategory).toBe(wrongActivation ? "activation" : null);
        expect(result.oracle.answer).toBeNull();
        expect(gateway.behavior.finalResponsePresent).toBe(true);
        expect(gateway.deliveredFiles).toMatchObject([
          { source: "report.json", status: "captured" },
          { source: "unsafe-link", status: "unavailable" },
          { source: "../outside.txt", status: "unavailable" },
        ]);
        const delivered = path.join(root, "cells", "receipt-boundary", "delivered");
        expect(fs.readFileSync(path.join(delivered, "report.json"), "utf8")).toBe(
          '{"note":"[REDACTED]"}\n',
        );
        expect(fs.existsSync(path.join(delivered, "unsafe-link"))).toBe(false);
        return;
      }
      if (modelError) {
        expect(result.failureCategory).toBe("model_unavailable");
        expect(result.codeModeEngaged).toBeNull();
        expect(result.error?.message).toContain("Gateway HTTP 500");
        expect(result.error?.message).toContain("agent run failed");
        return;
      }
      expect(result.oracle.identity).toBe(true);
      expect(result.oracle.engagement).toBe(true);
      expect(gateway.behavior.exactlyOneEffect).toBe(true);
      expect(result.failureCategory).toBe("interview_mismatch");
      expect(gateway.interview.checks.noExternalAction).toBe(false);
      const artifacts = path.join(root, "cells", "receipt-boundary");
      const readReceipts = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(artifacts, name), "utf8")) as {
          kind: string;
          tool: string;
        }[];
      const rawEvidence = JSON.parse(
        fs.readFileSync(path.join(artifacts, "evidence.json"), "utf8"),
      );
      expect(rawEvidence.task.usage).toMatchObject({ input_tokens: 20, output_tokens: 4 });
      expect(rawEvidence.interview.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
      expect(rawEvidence.activationComplete).toBe(true);
      expect(rawEvidence.observedActivation).toEqual([
        {
          runId: "task-response",
          active: true,
          toolsEnabled: true,
          toolsDisabled: false,
          rawRun: false,
          fallbackActive: false,
          allowlist: "unset",
        },
      ]);
      const timeline = JSON.parse(
        fs.readFileSync(path.join(root, "response-timeline.json"), "utf8"),
      ) as { interview: boolean; requestAt: number; responseAt: number }[];
      const taskResponseAt = expectDefined(gateway.taskResponseAt, "root response boundary");
      expect(taskResponseAt).toBeGreaterThanOrEqual(
        expectDefined(timeline[0], "task response timing").responseAt,
      );
      expect(taskResponseAt).toBeLessThanOrEqual(
        expectDefined(timeline[1], "interview request timing").requestAt,
      );
      const taskReceipts = readReceipts("task-receipts.json");
      const interviewReceipts = readReceipts("interview-receipts.json");
      expect(taskReceipts.map(({ kind, tool }) => `${kind}:${tool}`)).toEqual([
        "call:matrix_settle",
        "effect:matrix_settle",
        "call:matrix_settlement_inspect",
      ]);
      expect(interviewReceipts.map(({ kind, tool }) => `${kind}:${tool}`)).toEqual([
        "call:matrix_settle",
        "effect:matrix_settle",
      ]);
      expect(readReceipts("receipts.json")).toEqual([...taskReceipts, ...interviewReceipts]);
    } finally {
      fixtureOverride?.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);
