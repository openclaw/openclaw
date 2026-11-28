// Real built Gateway owns normalization, saved cron authority, approvals and marker I/O.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { writePersistedAuthProfileStoreRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "../../../../src/plugin-sdk/gateway-runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createDeferred } from "../../../helpers/promise.js";

const MODEL = "openai/gpt-5.6-luna";
const SESSION = "agent:main:qa-scheduled-shell-creator";
let instance: OpenClawTestInstance | undefined;
const clients: GatewayClient[] = [];
type TransportEntry = {
  direction: "in" | "out";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { success?: boolean; contentItems?: { type: string; text?: string }[] };
};

async function readTransport(file: string): Promise<TransportEntry[]> {
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TransportEntry);
}

function advertisedNames(specs: unknown): string[] {
  if (!Array.isArray(specs)) {
    return [];
  }
  return specs.flatMap((spec: { type?: string; name: string; tools?: unknown }) =>
    spec.type === "namespace" ? advertisedNames(spec.tools) : [spec.name],
  );
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

async function connect(owner: OpenClawTestInstance) {
  const ready = createDeferred();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${owner.port}`,
    token: owner.gatewayToken,
    clientName: "gateway-client",
    clientDisplayName: "Scheduled shell proof reviewer",
    deviceIdentity: null,
    mode: "backend",
    caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
    scopes: ["operator.admin", "operator.approvals", "operator.read", "operator.write"],
    onHelloOk: () => ready.resolve(),
    onConnectError: ready.reject,
  });
  clients.push(client);
  const readiness = await startGatewayClientWhenEventLoopReady(client, { timeoutMs: 20_000 });
  expect(readiness.ready).toBe(true);
  await ready.promise;
  return client;
}

async function absent(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

function storedJob(owner: OpenClawTestInstance, id: string) {
  // Read only this fixture's private database, not the running user's state.
  const db = new DatabaseSync(path.join(owner.stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(id) as
      | { job_json: string }
      | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.job_json);
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform === "win32")(
  "saved scheduled shell authority through the built Gateway",
  () => {
    it(
      "persists a normalized Gateway alias and enforces its always-ask floor on real commands",
      { timeout: 240_000 },
      async () => {
        const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
          CODEX_APP_SERVER_VERSION: string;
        }>({ pluginId: "codex", artifactBasename: "test-api.js" });
        const fixture = fileURLToPath(
          new URL("./scheduled-shell-authority-app-server.fixture.mjs", import.meta.url),
        );
        const repo = fileURLToPath(new URL("../../../../", import.meta.url));
        await fs.stat(path.join(repo, "dist/index.js"));
        instance = await createOpenClawTestInstance({
          name: "qa-saved-scheduled-shell",
          cwd: repo,
          entrypoint: ["dist/index.js"],
          env: {
            OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
            OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
            OPENCLAW_SYSTEMD_UNIT: `openclaw-qa-scheduled-shell-${randomUUID()}`,
            OPENCLAW_SERVICE_MARKER: undefined,
            OPENCLAW_SERVICE_KIND: undefined,
            OPENCLAW_SKIP_CRON: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          },
          config: {
            tools: { exec: { host: "gateway", mode: "full" } },
            plugins: {
              allow: ["codex", "openai"],
              entries: {
                openai: { enabled: true },
                codex: {
                  enabled: true,
                  config: {
                    appServer: {
                      mode: "yolo",
                      command: process.execPath,
                      args: [fixture],
                      requestTimeoutMs: 60_000,
                    },
                  },
                },
              },
            },
            agents: {
              defaults: {
                model: { primary: MODEL, fallbacks: [] },
                modelPolicy: { allow: [MODEL] },
                models: { [MODEL]: { agentRuntime: { id: "codex" } } },
                workspace: "~/workspace",
                skipBootstrap: true,
                timeoutSeconds: 60,
                sandbox: { mode: "off" },
              },
            },
          },
        });
        const owner = instance;
        const planPath = owner.state.path("scheduled-shell-plan.json");
        const logPath = owner.state.path("scheduled-shell-transport.jsonl");
        owner.env.OPENCLAW_QA_SCHEDULED_SHELL_PLAN = planPath;
        owner.env.OPENCLAW_QA_SCHEDULED_SHELL_LOG = logPath;
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: {
              "openai:qa-oauth": {
                type: "oauth",
                provider: "openai",
                access: "test-scheduled-shell-oauth",
                refresh: "test-refresh",
                expires: Date.UTC(2036, 0, 1),
                accountId: "qa-scheduled-shell",
              },
            },
            order: { openai: ["openai:qa-oauth"] },
          },
          owner.state.agentDir(),
        );
        await closeOpenClawAgentDatabasesAsync();
        const jobName = `qa-scheduled-shell-${randomUUID()}`;
        await fs.writeFile(
          planPath,
          JSON.stringify({
            id: randomUUID(),
            phase: "create",
            job: {
              name: jobName,
              enabled: false,
              schedule: { kind: "every", everyMs: 86_400_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              delivery: { mode: "none" },
              payload: {
                kind: "agentTurn",
                message: "Execute the deterministic scheduled shell fixture.",
                model: MODEL,
                toolsAllow: ["gateway_exec", "gateway_process"],
              },
            },
          }),
        );
        await owner.startGateway();
        let client = await connect(owner);
        await client.request("sessions.patch", { key: SESSION, permissionMode: "guarded" });
        const started = await client.request<{ status: string; runId: string }>("chat.send", {
          sessionKey: SESSION,
          message: "Create the deterministic scheduled shell fixture.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        const completed = await client.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 70_000 },
        );
        expect(completed).toMatchObject({ status: "ok" });
        const creatorThread = (await readTransport(logPath)).find(
          (entry) => entry.direction === "in" && entry.method === "thread/start",
        );
        expect(creatorThread?.params).toMatchObject({
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          approvalsReviewer: "user",
        });
        expect(advertisedNames(creatorThread?.params?.dynamicTools)).toEqual(
          expect.arrayContaining(["gateway_exec", "gateway_process"]),
        );
        const listed = await client.request<{
          jobs: { id: string; name: string; payload: { toolsAllow: string[] } }[];
        }>("cron.list", { includeDisabled: true });
        const job = listed.jobs.find((item) => item.name === jobName);
        expect(job, await fs.readFile(logPath, "utf8")).toBeDefined();
        expect(job!.payload.toolsAllow).toEqual(["exec", "process"]);
        const pin = { version: 1, host: "gateway", ask: "always" };
        expect(storedJob(owner, job!.id).toolsAllowExecTarget).toEqual(pin);
        console.info(
          "[scheduled-shell-proof] built Gateway: public provider captured canonical exec/process; saved Gateway and always-ask pin verified",
        );
        client.stop();
        await owner.stopGateway();
        await owner.startGateway();
        client = await connect(owner);
        expect(storedJob(owner, job!.id).toolsAllowExecTarget).toEqual(pin);
        console.info("[scheduled-shell-proof] built Gateway: saved pin survived restart");
        const defaults = await client.request<{ hash: string; file: Record<string, unknown> }>(
          "exec.approvals.get",
          {},
        );
        await client.request("exec.approvals.set", {
          baseHash: defaults.hash,
          file: {
            ...defaults.file,
            version: 1,
            defaults: { security: "full", ask: "off", askFallback: "deny" },
          },
        });
        // A separate full-permission turn must execute without an approval under
        // the same global policy. Otherwise a global guard could mask a lost pin.
        const controlMarker = path.join(owner.state.workspaceDir, "unpinned-full-control");
        await absent(controlMarker);
        await fs.writeFile(
          planPath,
          JSON.stringify({
            id: randomUUID(),
            phase: "execute",
            arguments: {
              command: `touch ${JSON.stringify(controlMarker)}`,
              workdir: owner.state.workspaceDir,
              timeoutSeconds: 5,
            },
          }),
        );
        const controlKey = "agent:main:qa-scheduled-shell-full-control";
        await client.request("sessions.patch", { key: controlKey, permissionMode: "full" });
        const controlRun = await client.request<{ status: string; runId: string }>("chat.send", {
          sessionKey: controlKey,
          message: "Execute the unpinned full-permission control.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(controlRun.status).toBe("started");
        expect(
          await client.request(
            "agent.wait",
            { runId: controlRun.runId, timeoutMs: 60_000 },
            { timeoutMs: 70_000 },
          ),
        ).toMatchObject({ status: "ok" });
        expect(await fs.readFile(controlMarker, "utf8")).toBe("");
        expect(await client.request("exec.approval.list", {})).toEqual([]);
        console.info(
          "[scheduled-shell-proof] built Gateway: unpinned full-permission control produced its real effect without approval under the same global policy",
        );
        const markers: string[] = [];
        for (const [index, decision] of (["deny", "allow-once", "deny"] as const).entries()) {
          const marker = path.join(owner.state.workspaceDir, `scheduled-shell-marker-${index}`);
          markers.push(marker);
          await absent(marker);
          await fs.writeFile(
            planPath,
            JSON.stringify({
              id: randomUUID(),
              phase: "execute",
              arguments: {
                command: `touch ${JSON.stringify(marker)}`,
                workdir: owner.state.workspaceDir,
                timeoutSeconds: 5,
                ...(index === 2 ? { ask: "off", security: "full" } : {}),
              },
            }),
          );
          const occurrenceStart = Date.now();
          const queued = await client.request("cron.run", { id: job!.id, mode: "force" });
          expect(queued).toMatchObject({ ok: true });
          const pending = await vi
            .waitFor(
              async () => {
                const list = await client.request<
                  { id: string; request: { host?: string; command?: string } }[]
                >("exec.approval.list", {});
                expect(list).toHaveLength(1);
                expect(list[0]!.request).toMatchObject({
                  host: "gateway",
                  command: `touch ${JSON.stringify(marker)}`,
                });
                return list[0]!;
              },
              { timeout: 60_000, interval: 50 },
            )
            .catch(async (error: unknown) => {
              const calls = (await fs.readFile(logPath, "utf8"))
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .filter(
                  (entry) =>
                    typeof entry.id === "string" && entry.id.startsWith("scheduled-shell-"),
                );
              const runs = await client.request("cron.runs", { id: job!.id, limit: 3 });
              throw new Error(
                `scheduled exec did not request approval: ${JSON.stringify({ queued, calls, runs })}`,
                { cause: error },
              );
            });
          await absent(marker);
          await client.request("exec.approval.resolve", { id: pending.id, decision });
          if (decision === "allow-once") {
            await vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).toBe(""), {
              timeout: 15_000,
              interval: 50,
            });
          }
          await vi.waitFor(
            async () => {
              const history = await client.request<{ entries: { action: string }[] }>("cron.runs", {
                id: job!.id,
                limit: 1,
              });
              expect(history.entries[0]?.action).toBe("finished");
              const current = await client.request<{
                state: { lastRunAtMs?: number; runningAtMs?: number };
              }>("cron.get", { id: job!.id });
              expect(current.state.runningAtMs).toBeUndefined();
              expect(current.state.lastRunAtMs).toBeGreaterThanOrEqual(occurrenceStart);
            },
            { timeout: 60_000, interval: 50 },
          );
          if (decision === "deny") {
            await absent(marker);
          }
          console.info(
            `[scheduled-shell-proof] built Gateway: scheduled occurrence ${index + 1} required Gateway approval; ${decision}; effect ${decision === "allow-once" ? "present" : "absent"}`,
          );
        }
        await absent(markers[0]!);
        expect(await fs.readFile(markers[1]!, "utf8")).toBe("");
        await absent(markers[2]!);
        for (const [index, broader] of [
          { host: "node", node: "qa-not-a-connected-node" },
          { node: "qa-not-a-connected-node" },
        ].entries()) {
          const marker = path.join(owner.state.workspaceDir, `scheduled-shell-broader-${index}`);
          await absent(marker);
          const prior = (await readTransport(logPath)).length;
          await fs.writeFile(
            planPath,
            JSON.stringify({
              id: randomUUID(),
              phase: "execute",
              arguments: {
                command: `touch ${JSON.stringify(marker)}`,
                workdir: owner.state.workspaceDir,
                timeoutSeconds: 5,
                ...broader,
              },
            }),
          );
          const occurrenceStart = Date.now();
          expect(await client.request("cron.run", { id: job!.id, mode: "force" })).toMatchObject({
            ok: true,
          });
          const boundary = await vi.waitFor(
            async () => {
              const transport = (await readTransport(logPath)).slice(prior);
              const request = transport.find(
                (entry) => entry.direction === "out" && entry.method === "item/tool/call",
              );
              const reply = request
                ? transport.find((entry) => entry.direction === "in" && entry.id === request.id)
                : undefined;
              if (reply?.result?.success === false) {
                return { kind: "rejected" as const, reply };
              }
              const approvals = await client.request<
                { id: string; request: { host?: string; command?: string } }[]
              >("exec.approval.list", {});
              expect(approvals).toHaveLength(1);
              expect(approvals[0]!.request).toMatchObject({
                host: "gateway",
                command: `touch ${JSON.stringify(marker)}`,
              });
              return { kind: "approval" as const, approval: approvals[0]! };
            },
            { timeout: 20_000, interval: 50 },
          );
          await absent(marker);
          if (boundary.kind === "approval") {
            // Schema projection may discard unsupported host fields before execution.
            // Even then the saved always-ask floor must stop the real final effect.
            await client.request("exec.approval.resolve", {
              id: boundary.approval.id,
              decision: "deny",
            });
          } else {
            expect(
              boundary.reply.result?.contentItems?.map((item) => item.text ?? "").join("\n"),
            ).toMatch(/pinned to host=gateway|Invalid arguments|additional propert/i);
          }
          await vi.waitFor(
            async () => {
              const current = await client.request<{
                state: { lastRunAtMs?: number; runningAtMs?: number };
              }>("cron.get", { id: job!.id });
              expect(current.state.runningAtMs).toBeUndefined();
              expect(current.state.lastRunAtMs).toBeGreaterThanOrEqual(occurrenceStart);
            },
            { timeout: 60_000, interval: 50 },
          );
          expect(await client.request("exec.approval.list", {})).toEqual([]);
          expect(storedJob(owner, job!.id).toolsAllowExecTarget).toEqual(pin);
          await absent(marker);
          console.info(
            `[scheduled-shell-proof] built Gateway: broader target ${index + 1} ${boundary.kind === "approval" ? "required Gateway approval and was denied" : "was rejected"}; saved pin retained; effect absent`,
          );
        }
      },
    );
  },
);
