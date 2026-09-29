// Manual real-Gateway/native-Codex probe for #156353. Only inference is synthetic.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createDeferred } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const marker = "RELOAD_ADMISSION_PROOF";
const model = "gpt-5.2"; // Model responses come from the deterministic local HTTP fixture.
function respond(res: ServerResponse, item: Record<string, unknown>) {
  const id = "resp_" + randomUUID();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
      },
    },
  ]) {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  }
  res.end("data: [DONE]\n\n");
}
it.runIf(process.env.OPENCLAW_E2E_RELOAD_TRANSCRIPT_PROOF === "1")(
  "continues one logical request after a real plugin reload",
  { timeout: 360_000 },
  async () => {
    const root = tempDirs.make("reload-admission-proof-");
    const pluginRoot = path.join(root, "plugin");
    let effectFile = path.join(root, "effects.txt");
    await fs.mkdir(pluginRoot);
    await fs.writeFile(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "reload-admission-probe",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "reload-admission-probe",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginRoot, "index.mjs"),
      'export default { id: "reload-admission-probe", register() {} };',
    );
    const requests: Array<Record<string, unknown>> = [];
    let step = 0;
    let recoveryControl = false;
    const cancelContinuation = process.env.RELOAD_PROOF_CANCEL === "1";
    const raceConfirmation = process.env.RELOAD_PROOF_RACE === "1";
    const steering =
      cancelContinuation || raceConfirmation || process.env.RELOAD_PROOF_STEER === "1";
    const continuationStarted = createDeferred();
    const releaseContinuation = createDeferred();
    const beforeSteer = createDeferred();
    const steerAccepted = createDeferred();
    const steerConfirmed = createDeferred();
    const server = createServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) {
          raw += String(chunk);
        }
        if (req.method === "GET" && req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: model, object: "model" }] }));
          return;
        }
        if (!req.url?.endsWith("/responses")) {
          res.writeHead(404).end();
          return;
        }
        const body = JSON.parse(raw);
        const specs: Array<{ name: string; namespace?: string }> = [];
        const visit = (tools: Array<Record<string, unknown>>, namespace?: string) => {
          for (const t of tools ?? []) {
            if (Array.isArray(t.tools)) {
              visit(t.tools, typeof t.name === "string" ? t.name : namespace);
            } else if (typeof t.name === "string") {
              specs.push({ name: t.name, ...(namespace ? { namespace } : {}) });
            }
          }
        };
        visit(body.tools ?? []);
        const names = specs.map((t) => [t.namespace, t.name].filter(Boolean).join("."));
        const isProof = raw.includes(marker);
        requests.push({
          url: req.url,
          isProof,
          step,
          names,
          hasEffect: raw.includes("EFFECT_COMMITTED"),
          hasRefresh: raw.includes("plugin runtime has been refreshed"),
        });
        if (!isProof || recoveryControl) {
          respond(res, {
            type: "message",
            role: "assistant",
            id: "msg_" + randomUUID(),
            content: [{ type: "output_text", text: "CONTROL_OK" }],
          });
          return;
        }
        const selected = step++;
        console.log("PROOF_INFERENCE", JSON.stringify({ selected, steering, names }));
        if (steering && selected === 1) {
          beforeSteer.resolve();
          await steerAccepted.promise;
        }
        if (steering && selected === 2 && !raceConfirmation) {
          await steerConfirmed.promise;
        }
        if (cancelContinuation && selected === 3) {
          continuationStarted.resolve();
          await releaseContinuation.promise;
        }
        if (selected < (steering ? 4 : 2)) {
          const wanted =
            selected === 0
              ? specs.some((t) => t.name === "exec_command")
                ? "exec_command"
                : "exec"
              : "plugins";
          const tool = specs.find((t) => t.name === wanted);
          if (!tool) {
            throw new Error("Proof tool not advertised: " + wanted + "; " + names.join(","));
          }
          respond(res, {
            type: "function_call",
            id: "fc_" + randomUUID(),
            call_id: "call_" + randomUUID(),
            ...tool,
            arguments: JSON.stringify(
              selected === 0
                ? {
                    [wanted === "exec_command" ? "cmd" : "command"]:
                      "printf 'effect\\n' >> " +
                      JSON.stringify(effectFile) +
                      "; printf EFFECT_COMMITTED",
                    ...(wanted === "exec_command" ? { max_output_tokens: 1000 } : {}),
                  }
                : {
                    action: steering && selected === 1 ? "inspect" : "reload",
                    pluginId: "reload-admission-probe",
                  },
            ),
          });
        } else {
          respond(res, {
            type: "message",
            role: "assistant",
            id: "msg_" + randomUUID(),
            content: [{ type: "output_text", text: marker + "_DONE" }],
          });
        }
      })().catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no provider port");
    }
    const owner = createQaGatewayChild();
    let gateway: Awaited<ReturnType<typeof owner.start>> | undefined;
    try {
      gateway = await owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["dist/index.js"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        transportBaseUrl: "http://127.0.0.1",
        providerMode: "mock-openai",
        providerBaseUrl: "http://127.0.0.1:" + addr.port + "/v1",
        primaryModel: `mock-openai/${model}`,
        alternateModel: `mock-openai/${model}`,
        forcedRuntime: "codex",
        enabledPluginIds: ["codex"],
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          plugins: {
            ...cfg.plugins,
            allow: [...(cfg.plugins?.allow ?? []), "reload-admission-probe"],
            load: { paths: [pluginRoot] },
            entries: { ...cfg.plugins?.entries, "reload-admission-probe": { enabled: true } },
          },
          tools: {
            ...cfg.tools,
            toolSearch: false,
            exec: { ...cfg.tools?.exec, security: "full", ask: "off" },
          },
        }),
      });
      effectFile = path.join(gateway.workspaceDir, "reload-proof-effects.txt");
      console.log("PROOF_GATEWAY_READY");
      const key = "agent:qa:reload-admission-proof";
      await gateway.call("sessions.create", { key, agentId: "qa" });
      const before = await gateway.call("plugins.list", {});
      const runId = randomUUID();
      const started = await gateway.call("chat.send", {
        sessionKey: key,
        message:
          marker +
          ": record the proof effect, reload reload-admission-probe, then confirm without repeating the effect.",
        deliver: false,
        idempotencyKey: runId,
      });
      console.log("PROOF_ORIGINAL_ACK", started);
      const terminal = gateway.call(
        "agent.wait",
        { runId, timeoutMs: 180_000 },
        { timeoutMs: 190_000 },
      );
      const readIdentity = () => {
        const db = new DatabaseSync(
          path.join(gateway!.tempRoot, "state", "agents", "qa", "agent", "openclaw-agent.sqlite"),
          { readOnly: true },
        );
        try {
          return db
            .prepare(
              `SELECT identity.event_id, identity.seq, identity.parent_id, active.message_position, rewrite.generation FROM transcript_event_identities identity JOIN session_transcript_active_events active ON active.session_id=identity.session_id AND active.event_seq=identity.seq JOIN transcript_rewrite_watermarks rewrite ON rewrite.session_id=identity.session_id WHERE identity.message_idempotency_key = ?`,
            )
            .get(runId + ":user");
        } finally {
          db.close();
        }
      };
      if (steering) {
        await Promise.race([
          beforeSteer.promise,
          terminal.then((result) => {
            throw new Error(
              "Original turn ended before steering barrier: " +
                JSON.stringify({ result, requests }),
            );
          }),
        ]);
        console.log("ORIGINAL_BEFORE_STEER", readIdentity());
        const steerId = randomUUID();
        console.log(
          "STEER_ACK",
          await gateway.call("chat.send", {
            sessionKey: key,
            message: "STEER_PROOF: preserve the completed effect when reloading.",
            queueMode: "steer",
            deliver: false,
            idempotencyKey: steerId,
          }),
        );
        steerAccepted.resolve();
        const confirmation = await gateway.call(
          "agent.wait",
          { runId: steerId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        console.log("STEER_CONFIRMATION", confirmation);
        expect(confirmation).toMatchObject({ status: "ok" });
        console.log("ORIGINAL_AFTER_STEER", readIdentity());
        steerConfirmed.resolve();
      }
      if (cancelContinuation) {
        await Promise.race([
          continuationStarted.promise,
          terminal.then((result) => {
            throw new Error("Turn ended before cancellation barrier: " + JSON.stringify(result));
          }),
        ]);
        const stopped = await gateway.call("chat.abort", { sessionKey: key, runId });
        console.log("CONTINUATION_STOP", JSON.stringify(stopped));
        expect(stopped).toMatchObject({ aborted: true, runIds: [runId] });
        releaseContinuation.resolve();
      }
      const outcome = await terminal;
      const history = await gateway.call("chat.history", { sessionKey: key, limit: 100 });
      const after = await gateway.call("plugins.list", {});
      const effects = await fs.readFile(effectFile, "utf8").catch(() => "");
      console.log(
        "RELOAD_PROOF",
        JSON.stringify({
          started,
          outcome,
          effects,
          requests,
          before: { generation: (before as { generation?: number }).generation },
          after: { generation: (after as { generation?: number }).generation },
          history,
        }),
      );
      console.log("RELOAD_GATEWAY_LOG", gateway.logs().slice(-18000));
      if (!cancelContinuation && (outcome as { status?: string }).status !== "ok") {
        recoveryControl = true;
        const recoveryId = randomUUID();
        await gateway.call("chat.send", {
          sessionKey: key,
          message:
            "Recovery control: report the already completed task without repeating any action.",
          deliver: false,
          idempotencyKey: recoveryId,
        });
        const recovery = await gateway.call(
          "agent.wait",
          { runId: recoveryId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        console.log(
          "SEPARATE_PROMPT_RECOVERY_CONTROL",
          JSON.stringify({
            recovery,
            effects: await fs.readFile(effectFile, "utf8").catch(() => ""),
          }),
        );
      }
      const messages = (
        history as { messages: Array<{ role: string; idempotencyKey?: string; content: unknown }> }
      ).messages;
      const originals = messages.filter(
        (m) => m.role === "user" && m.idempotencyKey === runId + ":user",
      );
      const finals = messages.filter(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes(marker + "_DONE"),
      );
      const initialGeneration = (before as { generation: number }).generation;
      const finalGeneration = (after as { generation: number }).generation;
      console.log(
        "PROOF_INVARIANTS",
        JSON.stringify({
          steering,
          cancelContinuation,
          raceConfirmation,
          originalMessages: originals.length,
          finalMessages: finals.length,
          effectCount: effects.split("\n").filter(Boolean).length,
          pluginReloads: finalGeneration - initialGeneration,
          originalStatus: (outcome as { status: string }).status,
        }),
      );
      expect(outcome).toMatchObject(
        cancelContinuation ? { status: "error", stopReason: "rpc" } : { status: "ok" },
      );
      expect(effects).toBe("effect\n");
      expect(originals).toHaveLength(1);
      expect(finals).toHaveLength(cancelContinuation ? 0 : 1);
      expect(finalGeneration - initialGeneration).toBe(steering && !cancelContinuation ? 2 : 1);
      expect(requests.some((r) => r.hasRefresh)).toBe(true);
    } finally {
      if (gateway) {
        console.log("RELOAD_GATEWAY_FINAL_LOG", gateway.logs().slice(-10000));
      }
      steerAccepted.resolve();
      steerConfirmed.resolve();
      releaseContinuation.resolve();
      await stopQaGatewayFixture(owner);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
