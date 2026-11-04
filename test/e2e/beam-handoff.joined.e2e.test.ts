import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../src/infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../src/infra/device-pairing.js";
import { resolveGatewayClientPlatformIdentity } from "../../src/shared/gateway-client-platform.js";
import { setUserProfileRole } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../../src/utils/message-channel.js";
import {
  createGatewayProxy,
  gatewayProxyRoute,
} from "../../ui/src/e2e/gateway-proxy.test-support.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";
import { runCleanups, runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

it("continues one released Beam conversation through real client, Gateway, restart and revocation", async ({
  signal,
  onTestFinished,
}) => {
  const commands = createFixtureLifetime();
  const commandOwner = new AbortController();
  let commandCleanup: Promise<void> | undefined;
  const drainCommands = () => {
    commandOwner.abort();
    return (commandCleanup ??= commands.cleanup());
  };
  onTestFinished(drainCommands);
  let instance: OpenClawTestInstance | undefined;
  const proxies: ViteDevServer[] = [];
  let calls = 0;
  const provider = await startOpenAiResponsesModelServer({
    modelId: "echo",
    bindError: "fixture listener unavailable",
    async onRequest(request, response) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_000_000) {
          throw new Error("fixture request bound");
        }
      }
      expect(JSON.parse(body)).toMatchObject({ model: "echo" });
      calls += 1;
      writeOpenAiResponsesText(response, {
        text: `Joined Team response ${calls}`,
        messageId: `joined-${calls}`,
        responseId: `joined-response-${calls}`,
      });
    },
  });
  await runQaGatewayFixture(
    async () => {
      const model = createOpenAiResponsesModelConfig({
        baseUrl: provider.baseUrl,
        providerId: "fixture",
        modelId: "echo",
        reasoning: false,
        toolProfile: "minimal",
      });
      instance = await createOpenClawTestInstance({
        name: "beam-joined-handoff",
        signal,
        env: {
          VITEST: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
            .filter(Boolean)
            .join(","),
        },
        config: {
          ...model,
          cron: { enabled: false },
          plugins: {
            allow: ["beam"],
            entries: { beam: { enabled: true } },
            slots: { memory: "none" },
          },
          gateway: {
            trustedProxies: ["127.0.0.1", "::1"],
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                allowLoopback: true,
                allowUsers: ["publisher@example.test", "admin@example.test"],
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                deviceAutoApprove: {
                  enabled: true,
                  scopes: ["operator.admin", "operator.read", "operator.write"],
                },
              },
            },
            roles: {
              default: "member",
              definitions: {
                member: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "view" },
                },
                administrator: {
                  scopes: ["operator.admin"],
                  agents: "*",
                  sessions: { others: "write" },
                },
                blocked: { scopes: [], agents: "*", sessions: { others: "none" } },
              },
            },
          },
        },
      });
      const publisher = ensureProfileForEmail("publisher@example.test", { env: instance.env });
      const administrator = ensureProfileForEmail("admin@example.test", { env: instance.env });
      setUserProfileRole(publisher.id, "member", { env: instance.env });
      setUserProfileRole(administrator.id, "administrator", { env: instance.env });
      let lostAck = false;
      const releaseBodies = new WeakMap<IncomingMessage, string>();
      const urls: string[] = [];
      for (const [index, email] of ["publisher@example.test", "admin@example.test"].entries()) {
        const route = gatewayProxyRoute(instance.port, email, `192.0.2.${10 + index}`);
        const proxy = await createGatewayProxy(instance.state.workspaceDir, {
          "/": {
            ...route,
            ...(index === 0
              ? {
                  configure(transport) {
                    transport.on("start", (request) => {
                      if (request.method !== "POST" || request.url !== "/api/v1/beam/sessions") {
                        return;
                      }
                      let body = "";
                      request.on("data", (chunk) => {
                        body += chunk;
                      });
                      request.once("end", () => {
                        releaseBodies.set(request, body);
                      });
                    });
                    transport.on("proxyRes", (upstream, request, response) => {
                      if (
                        !lostAck &&
                        upstream.statusCode === 200 &&
                        releaseBodies.get(request)?.includes('"handoffId"')
                      ) {
                        lostAck = true;
                        response.destroy();
                        upstream.destroy();
                      }
                    });
                  },
                }
              : {}),
          },
        });
        proxies.push(proxy);
        await proxy.listen();
        const url = proxy.resolvedUrls?.local[0];
        if (!url) {
          throw new Error("fixture identity proxy unavailable");
        }
        urls.push(url);
      }
      const cfg = JSON.parse(await readFile(instance.configPath, "utf8"));
      delete cfg.gateway.auth.token;
      await instance.state.writeConfig(cfg);
      const root = instance.state.path("source-client");
      await mkdir(root);
      const client = path.resolve("test/fixtures/beam-live-handoff-client/beam.mjs");
      const cli = path.resolve("openclaw.mjs");
      const endpoint = `${urls[0]}api/v1/beam/sessions`;
      const profiles: string[] = [];
      for (const [index, url] of urls.entries()) {
        const dir = path.join(root, `profile-${index}`);
        await mkdir(dir);
        await writeFile(
          path.join(dir, "openclaw.json"),
          JSON.stringify({
            gateway: {
              mode: "remote",
              remote: { url: url.replace(/^http:/, "ws:") },
              auth: { mode: "trusted-proxy" },
            },
          }),
        );
        const identity = loadOrCreateDeviceIdentity({
          env: {
            ...instance.env,
            OPENCLAW_STATE_DIR: dir,
            OPENCLAW_CONFIG_PATH: path.join(dir, "openclaw.json"),
          },
        });
        const pending = await requestDevicePairing(
          {
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            ...resolveGatewayClientPlatformIdentity(process.platform),
            clientId: GATEWAY_CLIENT_NAMES.CLI,
            clientMode: GATEWAY_CLIENT_MODES.CLI,
            role: "operator",
            scopes: index === 0 ? ["operator.read", "operator.write"] : ["operator.admin"],
            silent: false,
          },
          instance.stateDir,
        );
        expect(
          await approveDevicePairing(
            pending.request.requestId,
            {
              callerScopes: ["operator.admin"],
              approvedVia: "owner",
            },
            instance.stateDir,
          ),
        ).toMatchObject({ status: "approved" });
        profiles.push(dir);
      }
      await instance.startGateway();
      const execute = (args: string[], profile = profiles[0]!, requestSignal = signal) => {
        commandOwner.signal.throwIfAborted();
        return commands.run(async () => {
          let stdout = "",
            stderr = "";
          const outputLimit = new AbortController();
          const status = await runManagedCommand({
            bin: process.execPath,
            args,
            cwd: process.cwd(),
            env: {
              ...instance!.env,
              OPENCLAW_STATE_DIR: profile,
              OPENCLAW_CONFIG_PATH: path.join(profile, "openclaw.json"),
              OPENCLAW_GATEWAY_TOKEN: "",
              OPENCLAW_GATEWAY_PASSWORD: "",
              OPENCLAW_GATEWAY_URL: "",
              OPENCLAW_GATEWAY_PORT: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
            signal: AbortSignal.any([
              signal,
              requestSignal,
              commandOwner.signal,
              outputLimit.signal,
            ]),
            timeoutMs: 130_000,
            requireProcessTreeExit: true,
            onReady(child) {
              child.stdout?.on("data", (chunk) => {
                stdout += chunk;
                if (stdout.length > 4_000_000) {
                  outputLimit.abort(new Error("fixture stdout bound"));
                }
              });
              child.stderr?.on("data", (chunk) => {
                stderr = (stderr + chunk).slice(-16_000);
              });
            },
          });
          return { status, stdout, stderr };
        });
      };
      const rpc = async (
        method: string,
        params: unknown,
        index = 0,
        requestSignal = signal,
      ): Promise<any> => {
        const out = await execute(
          [
            cli,
            "gateway",
            "call",
            method,
            "--expect-url",
            urls[index]!.replace(/^http:/, "ws:"),
            "--json",
            "--timeout",
            "120000",
            "--params",
            JSON.stringify(params),
          ],
          profiles[index],
          requestSignal,
        );
        expect(
          out.status,
          JSON.stringify({ method, stdout: out.stdout.slice(-6000), stderr: out.stderr }),
        ).toBe(0);
        return JSON.parse(out.stdout);
      };
      const transcript = path.join(root, "source.jsonl");
      const sourceId = "joined-source-session";
      await writeFile(
        transcript,
        [
          {
            type: "user",
            sessionId: sourceId,
            message: { role: "user", content: "Continue this synthetic work" },
          },
          {
            type: "assistant",
            sessionId: sourceId,
            message: {
              role: "assistant",
              model: "unavailable-source-model",
              content: [{ type: "text", text: "Original source answer" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const beamId = createHash("sha256").update(`claude:${sourceId}`).digest("hex").slice(0, 32);
      const state = path.join(root, "handoffs.sqlite");
      const beam = (command: string, args: string[], stateFile = state) =>
        execute([
          client,
          command,
          "--endpoint",
          endpoint,
          "--state",
          stateFile,
          "--cli",
          cli,
          ...args,
        ]);
      const published = await beam("publish", ["--session", transcript]);
      expect(published.status, published.stderr).toBe(0);
      const interrupted = await beam("handoff", ["--session", transcript]);
      expect(lostAck).toBe(true);
      expect(interrupted.status).not.toBe(0);
      const released = await beam("handoff", ["--beam-id", beamId]);
      expect(released.status, released.stderr).toBe(0);
      expect(released.stdout).toContain("Source Beam is retired");
      const bound = await rpc("sessions.catalog.continue", {
        catalogId: "beam",
        hostId: "gateway",
        threadId: beamId,
        agentId: "main",
      });
      const before = await rpc("chat.history", { sessionKey: bound.sessionKey });
      expect(JSON.stringify(before.messages)).toContain("Original source answer");
      const send = { sessionKey: bound.sessionKey, sessionId: before.sessionId };
      // sessionId belongs to the messageId selector; current history
      // is read by canonical key, then checked against the adopted identity.
      const history = async (requestSignal = signal) => {
        const result = await rpc(
          "chat.history",
          { sessionKey: bound.sessionKey },
          0,
          requestSignal,
        );
        expect(result.sessionId).toBe(before.sessionId);
        return result;
      };
      await rpc("chat.send", {
        ...send,
        message: "Team-only continuation",
        idempotencyKey: "joined-team-turn",
      });
      await expect
        .poll(
          async ({ signal: pollSignal }) => JSON.stringify((await history(pollSignal)).messages),
          {
            timeout: 30_000,
          },
        )
        .toContain("Joined Team response 1");
      const destinationArgs = ["--beam-id", beamId, "--profile-dir", profiles[0]!];
      const read = await beam("read", destinationArgs);
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ sessionId: before.sessionId });
      expect(read.stdout).toContain("Team-only continuation");
      for (let retry = 0; retry < 2; retry++) {
        const continued = await beam("continue", [
          ...destinationArgs,
          "--message",
          "Source-client follow-up",
          "--request-id",
          "joined-source-turn",
        ]);
        expect(continued.status, continued.stderr).toBe(0);
      }
      await expect
        .poll(
          async ({ signal: pollSignal }) => JSON.stringify((await history(pollSignal)).messages),
          {
            timeout: 30_000,
          },
        )
        .toContain("Joined Team response 2");
      expect(calls).toBe(2);
      await instance.stopGateway();
      await instance.startGateway();
      const reopened = await beam("read", destinationArgs);
      expect(reopened.status, reopened.stderr).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({ sessionId: before.sessionId });
      expect(reopened.stdout).toContain("Source-client follow-up");
      await writeFile(
        transcript,
        JSON.stringify({
          type: "user",
          sessionId: sourceId,
          message: { role: "user", content: "Late source marker must stay absent" },
        }) + "\n",
        { flag: "a" },
      );
      for (const stateFile of [state, path.join(root, "fresh-state.sqlite")]) {
        const late = await beam("publish", ["--session", transcript], stateFile);
        expect(late.status, late.stderr).toBe(0);
        expect(late.stdout).toContain("Source Beam is retired");
      }
      expect(JSON.stringify((await history()).messages)).not.toContain("Late source marker");
      await rpc("users.setRole", { profileId: publisher.id, role: "blocked" }, 1);
      for (const command of ["read", "continue"]) {
        const denied = await beam(
          command,
          command === "read"
            ? destinationArgs
            : [...destinationArgs, "--message", "Revoked source", "--request-id", "joined-denied"],
        );
        expect(denied.status).not.toBe(0);
      }
      expect(calls).toBe(2);
      const final = await rpc("chat.history", { sessionKey: bound.sessionKey }, 1);
      expect(JSON.stringify(final.messages)).not.toContain("Revoked source");
      expect(final.sessionId).toBe(before.sessionId);
      console.log(
        JSON.stringify({
          proof: "beam-joined-handoff",
          beamId,
          sessionKey: bound.sessionKey,
          sessionId: before.sessionId,
          lostAck,
          inferenceCalls: calls,
          sourceClient: "b637385f21ab78ada03d87bba25e16aa9f192404",
        }),
      );
    },
    // Poll deadlines can finish before their callbacks; join every CLI before
    // retiring its Gateway or removing any state used by that process tree.
    drainCommands,
    () => instance?.stopGateway(),
    () =>
      runCleanups(
        proxies.map((proxy) => () => proxy.close()),
        "proxy cleanup failed",
      ),
    async () => {
      // A failed join remains terminal even when another cleanup phase retries.
      // Retain state while any command's process tree is still unverified.
      await drainCommands();
      await instance?.cleanup();
    },
    () => provider.close(),
  );
}, 240_000);
