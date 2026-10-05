import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { loadCodexNodeAppServerTestFixture } from "../../extensions/codex/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { withNodeHostPluginInvocation } from "./invoke-plugin-context.js";
import { captureNodeWorkerManagedIdentityTransport } from "./node-worker-environment.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
});

it("carries the managed workspace transport through native Codex auth.command and a model turn", async () => {
  const header = "synthetic-codex-provider-header";
  const bearer = "synthetic-codex-provider-bearer";
  const audience = "api://913b0ac3-c7f3-49c7-82d5-7a3712848c42";
  const identity = "22fdd00c-31b3-4b46-ab87-e5203f925a65";
  const root = await fs.realpath(tempDirs.make("node-codex-provider-"));
  const caFile =
    process.platform === "darwin" ? "/etc/ssl/cert.pem" : "/etc/ssl/certs/ca-certificates.crt";
  await fs.access(caFile);
  const platformTrust = Object.freeze({
    REQUESTS_CA_BUNDLE: caFile,
    SSL_CERT_FILE: caFile,
    NODE_EXTRA_CA_CERTS: caFile,
    NODE_USE_SYSTEM_CA: "1",
  });
  const shellProbe = `node -e 'const expected=${JSON.stringify(platformTrust)}; if(!Object.entries(expected).every(([key,value])=>process.env[key]===value))process.exit(1); console.log("CA_TRUST_PASS")'`;
  const identityRequests: { headerMatches: boolean; purposeMatches: boolean }[] = [];
  const modelRequests: boolean[] = [];
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        if (url.pathname === "/identity") {
          identityRequests.push({
            headerMatches: req.headers["x-identity-header"] === header,
            purposeMatches:
              url.searchParams.get("resource") === audience &&
              url.searchParams.get("client_id") === identity,
          });
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              access_token: bearer,
              resource: audience,
              expires_on: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
          return;
        }
        if (req.method !== "POST" || url.pathname !== "/v1/responses") {
          res.writeHead(404).end();
          return;
        }
        req.resume();
        req.once("end", () => {
          const authenticated = req.headers.authorization === `Bearer ${bearer}`;
          modelRequests.push(authenticated);
          if (!authenticated) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "synthetic credential unavailable" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const item =
            modelRequests.length === 1
              ? {
                  type: "function_call",
                  call_id: "ca-probe",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: shellProbe,
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "fixture-answer",
                  content: [{ type: "output_text", text: `MI_PROVIDER_AUTH_PASS ${header}` }],
                };
          const events = [
            { type: "response.created", response: { id: "fixture-response" } },
            {
              type: "response.output_item.done",
              item,
            },
            {
              type: "response.completed",
              response: {
                id: "fixture-response",
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          res.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      }),
  });
  const endpoint = `http://127.0.0.1:${server.claim.port}/identity`;
  const state = path.join(root, "state");
  const configDir = path.join(state, "codex-runtime");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(configDir, "version"), "a".repeat(64), { mode: 0o600 });
  const helper = path.join(configDir, "autodev-token.mjs");
  await fs.writeFile(
    path.join(configDir, "config.toml"),
    `model = "codex-test-model"\nmodel_provider = "autodev"\n[model_providers.autodev]\nname = "AutoDev"\nbase_url = "http://127.0.0.1:${server.claim.port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.autodev.auth]\ncommand = "node"\nargs = [${JSON.stringify(helper)}]\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    helper,
    `
    import { get } from "node:http";
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(path.join(configDir, "auth-attempt.json"))}, JSON.stringify({ providerPairPresent: Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER), platformTrustPresent: Object.entries(${JSON.stringify(platformTrust)}).every(([key,value])=>process.env[key]===value) }));
    if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER || process.env.OPENCLAW_GATEWAY_TOKEN) {
      process.stderr.write("provider transport unavailable"); process.exit(1);
    }
    const url = new URL(process.env.IDENTITY_ENDPOINT);
    url.search = new URLSearchParams({ resource: ${JSON.stringify(audience)}, client_id: ${JSON.stringify(identity)} }).toString();
    get(url, { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } }, response => {
      response.setEncoding("utf8"); let body = "";
      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        const value = JSON.parse(body);
        if (value.resource !== ${JSON.stringify(audience)} || Number(value.expires_on) * 1000 <= Date.now() + 360000) process.exit(2);
        process.stdout.write(value.access_token + "\\n");
      });
    }).on("error", () => process.exit(3));
  `,
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("IDENTITY_ENDPOINT", endpoint);
  vi.stubEnv("IDENTITY_HEADER", header);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "synthetic-gateway-secret");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "node-host"),
    env: { HOME: root, PATH: process.env.PATH, ...platformTrust },
    managedIdentityTransport: captureNodeWorkerManagedIdentityTransport(process.env),
    platformTrust,
  });
  const owner = {
    gatewayNamespace: "codex-fixture",
    environmentId: "worker-fixture",
    sessionId: "session-fixture",
    generation: 1,
  };
  const created = await workspace.exec({ ...owner, argv: ["node", "-e", ""] });
  const placement = {
    cwd: created.workspaceDir,
    environmentId: owner.environmentId,
    sessionId: owner.sessionId,
    ownerEpoch: owner.generation,
    sessionKey: "agent:main:fixture",
  };
  const fixture = await loadCodexNodeAppServerTestFixture();
  fixture.setManagedCodexPluginRoot(
    fileURLToPath(new URL("../../extensions/codex/", import.meta.url)),
  );
  const command = fixture.createCodexNodeAppServerCommand();
  const abort = new AbortController();
  const replies = new EventEmitter();
  const frames: string[] = [];
  let receiver: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let listening!: () => void;
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const io = {
    signal: abort.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: {
      send: async (message: Uint8Array) => {
        const raw = Buffer.from(message).toString("utf8");
        frames.push(raw);
        const record = JSON.parse(raw) as { id?: number; method?: string };
        replies.emit(String(record.id), record);
        if (record.method) {
          replies.emit(record.method, record);
        }
      },
      onMessage: (listener: typeof receiver) => {
        receiver = listener;
        listening();
        return () => {
          receiver = undefined;
        };
      },
    },
  };
  const context: OpenClawPluginNodeHostCommandContext = {
    sendNodeEvent: async () => undefined,
    prepareExecAuthorization: () => () => abort.signal.throwIfAborted(),
    acquireManagedWorkspaceAsync: async (request) => {
      const lease = await workspace.acquireManagedWorkspaceAsync(request);
      expect(JSON.stringify(lease)).not.toContain(header);
      expect(JSON.stringify(lease)).not.toContain("IDENTITY_HEADER");
      return lease;
    },
  };
  const running = withNodeHostPluginInvocation(
    { context, sessionKey: placement.sessionKey, signal: abort.signal },
    (bound) =>
      command.handle(JSON.stringify({ placement, authorization: "session-full" }), io, bound),
  );
  void running.catch(() => {});
  const request = async (id: number, method: string, params: unknown) => {
    const response = once(replies, String(id));
    await receiver?.(Buffer.from(JSON.stringify({ id, method, params })));
    return (await response)[0] as { result?: unknown; error?: unknown };
  };
  try {
    await Promise.race([ready, running]);
    expect(
      await request(1, "initialize", fixture.buildCodexAppServerInitializeParams()),
    ).toHaveProperty("result");
    await receiver?.(Buffer.from(JSON.stringify({ method: "initialized", params: {} })));
    const started = await request(2, "thread/start", {
      cwd: placement.cwd,
      modelProvider: "autodev",
      model: "codex-test-model",
    });
    const threadId = (started.result as { thread: { id: string } }).thread.id;
    const completed = once(replies, "turn/completed");
    expect(
      await request(3, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Reply briefly.", text_elements: [] }],
      }),
    ).toHaveProperty("result");
    const completion = (await completed)[0];
    expect(
      JSON.parse(await fs.readFile(path.join(configDir, "auth-attempt.json"), "utf8")),
    ).toEqual({ providerPairPresent: true, platformTrustPresent: true });
    expect(completion).toMatchObject({ params: { turn: { status: "completed" } } });
    expect(identityRequests.length).toBeGreaterThan(0);
    expect(
      identityRequests.every(
        (observation) => observation.headerMatches && observation.purposeMatches,
      ),
    ).toBe(true);
    expect(modelRequests).toEqual([true, true]);
    expect(frames.join("\n")).toContain("CA_TRUST_PASS");
    expect(frames.join("\n")).not.toContain(header);
    expect(frames.join("\n")).not.toContain(bearer);
    const configs = await fs.readdir(path.join(configDir, "sessions"));
    for (const directory of configs) {
      const saved = await fs.readFile(
        path.join(configDir, "sessions", directory, "config.toml"),
        "utf8",
      );
      expect(saved).not.toContain(header);
      expect(saved).not.toContain(bearer);
      expect(saved).not.toContain("IDENTITY_HEADER");
    }
  } finally {
    abort.abort(new Error("fixture completed"));
    await running.catch(() => {});
    await command.onDisconnect?.();
    await workspace.processes.close();
    fixture.setManagedCodexPluginRoot(undefined);
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
}, 45_000);
