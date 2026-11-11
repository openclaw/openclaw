// Built Gateway + UI regression. OAuth, MCP, and model responses are synthetic; no live account is used.
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { stampConfigWriteMetadata } from "../../../src/config/io.meta.ts";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../src/test-helpers/proxy-tls-fixture.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const proof = createControlUiE2eArtifactDir("plugin-sign-in-resume");
const key = "agent:main:plugin-sign-in-recovery";
const blocked = "Docs needs your sign-in. The progress marker is already written.";
const done = "Recovered task finished; earlier progress was not repeated.";
let progressIssued = false;
let resumedToolIssued = false;
let resumedModelCalls = 0;
function toolReply(
  res: import("node:http").ServerResponse,
  name: string,
  args: object,
  id: string,
) {
  const item = {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    id: "fc_" + id,
    call_id: "call_" + id,
  };
  writeOpenAiResponsesSse(res, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response_" + id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}
let instance: OpenClawTestInstance;
let resource: string;
let consentOrigin: string;
let redirect: string;
let challenge: string;
let exchanges = 0;
let calls = 0;
let providerLease: Awaited<ReturnType<typeof reserveTestPortListener>>;
let consentLease: Awaited<ReturnType<typeof reserveTestPortListener>>;
const requests: string[] = [];
const provider = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", resource);
    requests.push(url.pathname);
    const json = (value: unknown, status = 200) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/v1/models") {
      return json({ data: [{ id: "recovery" }] });
    }
    if (url.pathname === "/v1/responses") {
      const body = JSON.parse(await text(req));
      const recovery = JSON.stringify(body.input).includes(
        "Plugin account sign-in completed for MCP server",
      );
      if (recovery) {
        resumedModelCalls++;
        if (!resumedToolIssued) {
          const echo = body.tools?.find((t: { name?: string }) => t.name?.includes("echo"));
          if (!echo) {
            throw new Error("Resumed turn did not discover the signed-in MCP tool");
          }
          resumedToolIssued = true;
          return toolReply(res, echo.name, {}, "docs-read");
        }
      }
      if (!progressIssued) {
        progressIssued = true;
        return toolReply(
          res,
          "exec",
          {
            command: "printf progress >> progress-marker.txt",
            workdir: instance.state.workspaceDir,
          },
          "progress",
        );
      }
      const link =
        "http://127.0.0.1:" +
        instance.port +
        "/settings/plugins/synthetic-docs?returnTo=" +
        encodeURIComponent(key);
      return writeOpenAiResponsesText(res, {
        text: resumedToolIssued ? done : blocked + " [Sign in and continue](" + link + ")",
        messageId: resumedToolIssued ? "finished" : "blocked",
        responseId: resumedToolIssued ? "resp_finished" : "resp_blocked",
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource, authorization_servers: [new URL(resource).origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const origin = new URL(resource).origin;
      return json({
        issuer: origin,
        authorization_endpoint: consentOrigin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(await text(req));
      redirect = body.redirect_uris[0];
      return json({ ...body, client_id: "synthetic-docs-client" });
    }
    if (url.pathname === "/authorize") {
      challenge = url.searchParams.get("code_challenge")!;
      const state = url.searchParams.get("state")!;
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        '<h1>Authorize synthetic Docs account</h1><p>Only the task-owned test service receives this consent.</p><form action="/decision"><input type="hidden" name="state" value="' +
          state +
          '"><button name="result" value="approve">Approve sign-in</button><button name="result" value="deny">Deny sign-in</button></form>',
      );
    }
    if (url.pathname === "/decision") {
      const callback = new URL(redirect);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", new URL(resource).origin);
      callback.searchParams.set(
        url.searchParams.get("result") === "approve" ? "code" : "error",
        url.searchParams.get("result") === "approve" ? "synthetic-code" : "access_denied",
      );
      return res.writeHead(302, { location: callback.href }).end();
    }
    if (url.pathname === "/token") {
      exchanges++;
      const form = new URLSearchParams(await text(req));
      if (
        form.get("code") !== "synthetic-code" ||
        form.get("redirect_uri") !== redirect ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== challenge
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({
        access_token: "synthetic-docs-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer synthetic-docs-access") {
        return res
          .writeHead(401, {
            "www-authenticate":
              'Bearer resource_metadata="' +
              new URL("/.well-known/oauth-protected-resource", resource).href +
              '"',
          })
          .end();
      }
      const raw = await text(req);
      if (!raw) {
        return res.writeHead(405).end();
      }
      const body = JSON.parse(raw);
      if (body.id === undefined) {
        return res.writeHead(202).end();
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-docs", version: "1.0.0" },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Read-only synthetic echo",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : (calls++,
              { content: [{ type: "text", text: "Authenticated synthetic Docs reply" }] });
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    res.writeHead(404).end();
  })().catch(() => res.writeHead(500).end());
});

const consentProvider = createHttpsServer(
  { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
  (req, res) => provider.emit("request", req, res),
);

const suite = createControlUiE2eSuite({
  name: "Plugin sign-in returns to the original task",
  startServerBeforeBrowser: true,
  async startServer() {
    await mkdir(proof, { recursive: true });
    providerLease = await reserveTestPortListener({ offsets: [0], createListener: () => provider });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture listener");
    }
    resource = "http://127.0.0.1:" + address.port + "/mcp";
    consentLease = await reserveTestPortListener({
      offsets: [0],
      createListener: () => consentProvider,
    });
    const consentAddress = consentProvider.address();
    if (!consentAddress || typeof consentAddress === "string") {
      throw new Error("No consent listener");
    }
    consentOrigin = "https://127.0.0.1:" + consentAddress.port;
    const root = path.join(proof, "synthetic-docs");
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      path.join(root, ".codex-plugin/plugin.json"),
      JSON.stringify({
        name: "synthetic-docs",
        version: "1.0.0",
        description: "Synthetic task proof only",
        mcpServers: { docs: { url: resource, auth: "oauth", transport: "streamable-http" } },
      }),
    );
    instance = await createOpenClawTestInstance({
      name: "installed-docs-recovery",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: stampConfigWriteMetadata(
        {
          gateway: { controlUi: { enabled: true } },
          update: { checkOnStart: false },
          cron: { enabled: false },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            exec: { host: "gateway", mode: "full" },
          },
          agents: {
            defaults: {
              model: "recovery-fixture/recovery",
              modelPolicy: { allow: ["recovery-fixture/*"] },
            },
            entries: { main: {} },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "recovery-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-fixture-key",
                baseUrl: new URL("/v1", resource).href,
                models: [
                  {
                    id: "recovery",
                    name: "Scripted recovery model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 131072,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: {
            allow: ["synthetic-docs"],
            load: { paths: [root] },
            entries: { "synthetic-docs": { enabled: true } },
          },
        },
        "2026.11.3",
        {},
      ),
    });
    const close = async () => {
      await writeFile(path.join(proof, "gateway.log"), instance.logs());
      try {
        await instance.cleanup();
      } finally {
        provider.closeAllConnections();
        await providerLease.releaseListener();
        await providerLease.claim.release();
        consentProvider.closeAllConnections();
        await consentLease.releaseListener();
        await consentLease.claim.release();
      }
    };
    try {
      await instance.startGateway();
    } catch (error) {
      await close();
      throw error;
    }
    return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
  },
});

suite.define(() => {
  it("cancels and denies without credentials, then signs in a plugin-only server through the real UI", async () => {
    await suite.withPage(
      {
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page: initialPage, context }) => {
        let page = initialPage;
        await pairControlUiPage(page, async (args) => {
          const r = await instance.cli(args);
          expect(r.code, r.stderr).toBe(0);
          return r.stdout;
        });
        const rpc = <T = unknown>(method: string, params: Record<string, unknown>) =>
          evaluateControlUiContext(
            page,
            (app, input) => app.gateway.snapshot.client!.request<T>(input.method, input.params),
            { method, params },
          );
        const inventory = await rpc<{ plugins: Array<{ id: string }> }>("plugins.list", {});
        expect(inventory.plugins.some((p) => p.id === "synthetic-docs")).toBe(true);
        const inspection = () =>
          rpc<{ mcpAuth: Array<{ serverName: string; state: string }> }>("plugins.inspect", {
            pluginId: "synthetic-docs",
          });
        const authored = JSON.parse(await readFile(instance.configPath, "utf8"));
        expect(authored.mcp?.servers?.docs).toBeUndefined();
        await rpc("sessions.create", { key, agentId: "main", label: "Recover the Docs task" });
        await rpc("chat.send", {
          sessionKey: key,
          message: "Write the progress marker once, then read Docs. Continue after I sign in.",
          idempotencyKey: "original-docs-task",
        });
        const history = () => rpc("chat.history", { sessionKey: key });
        await expect.poll(async () => JSON.stringify(await history())).toContain(blocked);
        expect(
          await readFile(path.join(instance.state.workspaceDir, "progress-marker.txt"), "utf8"),
        ).toBe("progress");
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
        const recoveryLink = page.getByRole("link", { name: "Sign in and continue", exact: true });
        await recoveryLink.waitFor();
        await page.screenshot({
          path: path.join(proof, "before-blocked-chat.png"),
          animations: "disabled",
        });
        if ((await recoveryLink.getAttribute("target")) === "_blank") {
          const opened = context.waitForEvent("page");
          await recoveryLink.click();
          page = await opened;
        } else {
          await recoveryLink.click();
        }
        const wakeRequests: unknown[] = [];
        page.on("websocket", (socket) =>
          socket.on("framesent", (frame) => {
            const request = JSON.parse(String(frame.payload));
            if (request.method === "system-event") {
              wakeRequests.push(request.params);
            }
          }),
        );
        const signIn = page.getByRole("button", { name: "Sign in to docs", exact: true }).first();
        await signIn.waitFor();
        expect(await signIn.textContent()).toBe("Sign in and continue task");
        const begin = async () => {
          await signIn.click();
          const link = page.locator(".wizard-step__external-link");
          await link.waitFor();
          const popup = context.waitForEvent("page");
          await link.click();
          const consent = await popup;
          await consent
            .getByRole("heading", { name: "Authorize synthetic Docs account" })
            .waitFor();
          return consent;
        };
        const modal = page.locator("openclaw-modal-dialog");
        const capture = async (filename: string) => {
          await page.bringToFront();
          const dialog = modal.locator("dialog");
          const content = dialog.locator(
            ".wizard-step__external-link,.model-setup-wizard__error-text",
          );
          const frame = await takeControlUiScreenshotFrame(page, dialog, [content], {
            animations: "disabled",
          });
          await writeFile(path.join(proof, filename), frame.png);
        };
        const cancelled = await begin();
        await capture("01-supported-sign-in.png");
        await modal.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
        const callback = cancelled.waitForResponse(
          (r) => new URL(r.url()).pathname === "/oauth/provider/callback",
        );
        await cancelled.getByRole("button", { name: "Approve sign-in" }).click();
        expect((await callback).status()).toBe(410);
        expect(exchanges).toBe(0);
        expect(wakeRequests).toHaveLength(0);
        expect(resumedModelCalls).toBe(0);
        expect((await inspection()).mcpAuth[0]?.state).not.toBe("authorized");
        await cancelled.close();
        const denied = await begin();
        await denied.getByRole("button", { name: "Deny sign-in" }).click();
        const error = modal.locator(".model-setup-wizard__error-text");
        await expect
          .poll(() => error.textContent())
          .toContain("The provider did not approve sign-in");
        await capture("02-denial-recovery.png");
        expect(exchanges).toBe(0);
        expect(wakeRequests).toHaveLength(0);
        expect(resumedModelCalls).toBe(0);
        expect((await inspection()).mcpAuth[0]?.state).not.toBe("authorized");
        await modal.getByRole("button", { name: "Close", exact: true }).click();
        await denied.close();
        const success = await begin();
        await success.getByRole("button", { name: "Approve sign-in" }).click();
        await expect.poll(async () => (await inspection()).mcpAuth[0]?.state).toBe("authorized");
        expect(exchanges).toBe(1);
        await expect.poll(async () => JSON.stringify(await history())).toContain(done);
        expect(wakeRequests).toHaveLength(1);
        expect(calls).toBe(1);
        expect(
          await readFile(path.join(instance.state.workspaceDir, "progress-marker.txt"), "utf8"),
        ).toBe("progress");
        await page.getByText(done, { exact: true }).waitFor();
        await page.screenshot({
          path: path.join(proof, "after-resumed-chat.png"),
          animations: "disabled",
        });
        await success.close();
        const configured = JSON.parse(await readFile(instance.configPath, "utf8"));
        expect(configured.mcp?.servers?.docs).toBeUndefined();
        await writeFile(
          path.join(proof, "receipt.json"),
          JSON.stringify(
            {
              build: "build-all ciArtifacts",
              model:
                "Scripted local openai-responses model: recovery-fixture/recovery. This proves runtime continuation and tool plumbing, not unscripted model reasoning or live-account authentication.",
              account: "synthetic",
              cancellationRejectsLateCallback: true,
              denialExchanges: 0,
              successfulExchanges: exchanges,
              pluginOnly: true,
              authorization: "operator.admin through standard paired browser",
              automaticChatContinuation:
                "one authorized system-event; scripted model continued the original task",
              wakeRequests: wakeRequests.length,
              resumedModelCalls,
              authenticatedCalls: calls,
              requests,
            },
            null,
            2,
          ),
        );
      },
    );
  });
});
