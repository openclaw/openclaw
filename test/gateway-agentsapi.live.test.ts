// Opt-in real Agents API proof: one isolated Gateway owns all lifecycle cases.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import OpenAI from "openai";
import { expect, it } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { redactSecrets } from "../src/logging/redact.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

type Completion = {
  status: string;
  terminalReply?: { text?: string };
  terminalReceipt?: {
    successfulToolNames?: string[];
    assistantTranscriptIdempotencyKey?: string;
  };
};

it.skipIf(!isLiveTestEnabled() || process.env.OPENCLAW_LIVE_AGENTS_API !== "1")(
  "continues, transfers files, restarts, stops and resets a hosted Agents API session",
  async (ctx) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENCLAW_LIVE_AGENTS_API_MODEL?.trim();
    if (!apiKey || !model) {
      ctx.skip("Set OPENAI_API_KEY and OPENCLAW_LIVE_AGENTS_API_MODEL for hosted Agents API proof");
      return;
    }
    const sdk = new OpenAI({ apiKey, baseURL: null, maxRetries: 0, timeout: 60_000 });
    const profile = "agentsapi-live-" + randomUUID();
    const instance = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["openclaw.mjs", "--profile", profile],
      state: { layout: "split" },
      env: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 30_000,
    });
    const sessionKey = "agent:main:" + profile;
    const nativeIds = new Set<string>();
    let client: GatewayClient | undefined;
    let activeRun: string | undefined;
    let onCommandStart: (() => void) | undefined;
    const connect = () =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: null,
          clientName: "gateway-client",
          mode: "backend",
          caps: ["tool-events"],
          scopes: ["operator.admin", "operator.read", "operator.write"],
          requestTimeoutMs: 300_000,
          onEvent: (event) => {
            const p = asOptionalRecord(event.payload);
            const d = asOptionalRecord(p?.data);
            if (
              event.event === "agent" &&
              p?.stream === "tool" &&
              d?.phase === "start" &&
              d.name === "bash"
            ) {
              onCommandStart?.();
            }
          },
        },
        {
          timeoutMs: 60_000,
          timeoutMessage: "Agents API Gateway connect timeout",
          closeMessage: "Agents API Gateway closed before connect",
        },
      );
    const nativeId = (result: Completion) => {
      const id = /^agentsapi:([^:]+):/.exec(
        result.terminalReceipt?.assistantTranscriptIdempotencyKey ?? "",
      )?.[1];
      if (!id) {
        throw new Error("No native Agents API identity on the completed reply");
      }
      nativeIds.add(id);
      return id;
    };
    const send = async (message: string, csv = false) => {
      const accepted = await client!.request<{ runId: string }>("chat.send", {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
        ...(csv
          ? {
              attachments: [
                {
                  type: "file",
                  mimeType: "text/csv",
                  fileName: "input.csv",
                  content: Buffer.from("value\n3\n8\n13\n").toString("base64"),
                },
              ],
            }
          : {}),
      });
      activeRun = accepted.runId;
      const result = await client!.request<Completion>("agent.wait", {
        runId: activeRun,
        timeoutMs: 240_000,
      });
      activeRun = undefined;
      expect(result.status, JSON.stringify(result)).toBe("ok");
      nativeId(result);
      return result;
    };
    const failures: unknown[] = [];
    try {
      await instance.state.writeConfig({
        plugins: {
          allow: ["openai", "agentsapi"],
          entries: { openai: { enabled: true }, agentsapi: { enabled: true } },
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: instance.state.workspaceDir,
            model: { primary: "openai/" + model },
            models: { ["openai/" + model]: { agentRuntime: { id: "agentsapi" } } },
            heartbeat: { every: "0m" },
            thinkingDefault: "low",
            timeoutSeconds: 240,
            skills: [],
          },
          entries: { main: {} },
        },
        tools: {
          profile: "full",
          codeMode: { enabled: false },
          web: { search: { enabled: false } },
        },
        gateway: {
          mode: "local",
          bind: "loopback",
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: false },
        },
        logging: { file: instance.state.path("gateway.log"), level: "debug" },
      });
      await fs.mkdir(instance.state.workspaceDir, { recursive: true });
      await fs.writeFile(
        path.join(instance.state.workspaceDir, "AGENTS.md"),
        "Synthetic integration test. Execute requested tools and report actual results. Do not contact other people.\n",
      );
      await instance.startGateway();
      client = await connect();
      const first = await send(
        "Use Python to compute the sum of squares from 1 through 100 and save it to /workspace/agentsapi-proof.txt. Call session_status once, then report the number. Do not search the web.",
      );
      expect(first.terminalReply?.text).toContain("338350");
      expect(first.terminalReceipt?.successfulToolNames).toEqual(
        expect.arrayContaining(["bash", "session_status"]),
      );
      const id = nativeId(first);
      const session = await sdk.beta.agents.sessions.retrieve(id);
      expect(session.environment.type).toBe("openai_hosted");
      expect(session.agent.tools.map((tool) => tool.type)).not.toContain("web_search");
      console.log("[agentsapi live] hosted execution, Gateway function and disabled search passed");
      const followup = await send(
        "Use the hosted shell to read /workspace/agentsapi-proof.txt. Report its exact contents; do not recalculate.",
      );
      expect(followup.terminalReply?.text).toContain("338350");
      expect(nativeId(followup)).toBe(id);
      const file = await send(
        "Read the attached CSV from /workspace/inputs with Python. Sum its value column and save only the sum plus a newline to /workspace/outputs/total.txt. State the sum and return that file as an attachment.",
        true,
      );
      expect(file.terminalReply?.text).toContain("24");
      expect(nativeId(file)).toBe(id);
      const outbound = path.join(instance.stateDir, "media/outbound");
      const bytes = await Promise.all(
        (await fs.readdir(outbound)).map((name) => fs.readFile(path.join(outbound, name))),
      );
      expect(bytes.some((buffer) => buffer.equals(Buffer.from("24\n")))).toBe(true);
      const history = await client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
        limit: 100,
      });
      expect(JSON.stringify(history.messages)).toContain('"type":"attachment"');
      console.log("[agentsapi live] same-session follow-up and managed attachment bytes passed");
      const oldPid = instance.child?.pid;
      await client.stopAndWait();
      client = undefined;
      await instance.stopGateway();
      await instance.startGateway();
      client = await connect();
      expect(instance.child?.pid).not.toBe(oldPid);
      const restarted = await send(
        "Read /workspace/agentsapi-proof.txt using the hosted shell and reply with its contents.",
      );
      expect(restarted.terminalReply?.text).toContain("338350");
      expect(nativeId(restarted)).toBe(id);
      console.log("[agentsapi live] cold Gateway restart preserved native session and workspace");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = new Promise<void>((resolve, reject) => {
        onCommandStart = resolve;
        timer = setTimeout(() => reject(new Error("No native command start before Stop")), 90_000);
      });
      void started.catch(() => {});
      try {
        const run = await client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message:
            "Run python -c 'import time; time.sleep(90)' in the hosted shell and wait for it. Do nothing else.",
          idempotencyKey: randomUUID(),
        });
        activeRun = run.runId;
        await started;
      } finally {
        clearTimeout(timer);
        onCommandStart = undefined;
      }
      const stream = await sdk.beta.agents.sessions.events.stream(id, {
        signal: AbortSignal.timeout(45_000),
      });
      const idle = (async () => {
        for await (const event of stream) {
          if (event.type === "agent.session.idle") {
            return;
          }
        }
        throw new Error("Native stream ended before cancellation settled");
      })();
      void idle.catch(() => {});
      try {
        const stopped = await client.request<{ aborted: boolean }>("chat.abort", {
          sessionKey,
          runId: activeRun,
        });
        expect(stopped.aborted).toBe(true);
        await client.request("agent.wait", { runId: activeRun, timeoutMs: 60_000 });
        await idle;
        activeRun = undefined;
      } finally {
        stream.controller.abort();
      }
      expect(
        (await sdk.beta.agents.sessions.turns.list(id, { limit: 1, order: "desc" })).data[0]
          ?.status,
      ).toBe("cancelled");
      await client.request("sessions.reset", { key: sessionKey, reason: "reset" });
      const reset = await send("Reply with exactly RESET_OK, without tools.");
      expect(reset.terminalReply?.text).toBe("RESET_OK");
      expect(nativeId(reset)).not.toBe(id);
      expect(
        await client.request("sessions.delete", { key: sessionKey, deleteTranscript: true }),
      ).toMatchObject({ deleted: true });
      console.log("[agentsapi live] active Stop, reset and deletion passed");
    } catch (error) {
      console.error(redactSecrets(instance.logs()));
      failures.push(error);
    }
    try {
      // Recover only this fixture's persisted native IDs if a reply failed before
      // returning its public receipt. Never inspect the operator's databases.
      const databasePath = path.join(instance.stateDir, "state/openclaw.sqlite");
      try {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          for (const row of database
            .prepare(
              "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
            )
            .all("agentsapi", "agentsapi-sessions")) {
            const record = asOptionalRecord(JSON.parse(String(row.value_json)));
            if (typeof record?.sessionId === "string") {
              nativeIds.add(record.sessionId);
            }
          }
        } finally {
          database.close();
        }
      } catch (error) {
        if (nativeIds.size) {
          console.error(
            "[agentsapi live] binding cleanup lookup unavailable",
            redactSecrets(String(error)),
          );
        }
      }
      if (client && activeRun) {
        await client.request("chat.abort", { sessionKey, runId: activeRun });
      }
      await client?.stopAndWait();
      await instance.stopGateway();
      for (const id of nativeIds) {
        const session = await sdk.beta.agents.sessions.retrieve(id);
        if (session.status !== "idle" && session.status !== "failed") {
          throw new Error("Native work is not settled; fixture state retained for cleanup: " + id);
        }
        expect((await sdk.beta.agents.sessions.delete(id)).deleted).toBe(true);
      }
      await instance.cleanup();
      console.log("[agentsapi live] owned cloud sessions and Gateway cleaned up");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Agents API live proof or owned-resource cleanup failed");
    }
  },
  600_000,
);
