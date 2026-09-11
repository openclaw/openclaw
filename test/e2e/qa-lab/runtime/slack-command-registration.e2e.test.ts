import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaPreparedRepoCliCommand } from "../../../helpers/qa-prepared-repo-cli.js";

const USER_ID = "U12345678";
const DENIED_USER_ID = "U87654321";
const CHANNEL_ID = "C12345678";
const MODEL = "mock-openai/slack-command-proof";
const evidenceRoot = path.resolve(
  ".artifacts/slack-command-registration",
  new Date().toISOString().replaceAll(":", "-"),
);

type CommandEvidence = {
  eventType: "slash_command" | "block_actions";
  command: string;
  text: string;
  userId: string;
  status: number;
  acknowledgement: string;
  responses: Record<string, unknown>[];
};

function configEvidence(config: unknown) {
  const root = asRecord(config);
  const slack = asRecord(asRecord(root.channels).slack);
  const slash = asRecord(slack.slashCommand);
  return {
    globalNative: asRecord(root.commands).native ?? "omitted",
    slackNative: asRecord(slack.commands).native ?? "omitted",
    nativeSkills: asRecord(slack.commands).nativeSkills,
    wrapperEnabled: slash.enabled ?? "omitted",
    wrapperName: slash.name,
    sessionPrefix: slash.sessionPrefix,
    ephemeral: slash.ephemeral,
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

// Existing unit tests replace Bolt registration and command dispatch. This
// boundary must prove a signed Slack request reaches the real command owner
// and produces exactly one visible reply, including when legacy flags are false.
test.each([
  { name: "omitted", enabled: undefined, wrapper: "openclaw" },
  { name: "explicit-false", enabled: false, wrapper: "openclaw" },
  { name: "both-true", enabled: true, wrapper: "openclaw" },
  { name: "wrapper-name-collision", enabled: true, wrapper: "help" },
])(
  "handles Slack commands through the Gateway ($name)",
  async ({ name, enabled, wrapper }) => {
    const evidenceDir = path.join(evidenceRoot, name);
    await fs.mkdir(evidenceDir, { recursive: true });
    const observed: CommandEvidence[] = [];
    let migration: Record<string, unknown> | undefined;
    let modelRequestCount: number | undefined;
    await withTempDir("openclaw-slack-commands-", async (directory) => {
      const adapter = await startOpenClawCrablineAdapter({
        channel: "slack",
        recorderPath: path.join(directory, "provider.jsonl"),
      });
      const owner = createQaGatewayChild();
      let gatewayForEvidence: Awaited<ReturnType<typeof owner.start>> | undefined;
      let provider: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
      const callbacks = new Map<string, Record<string, unknown>[]>();
      const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
        const route = request.url ?? "/";
        const body = await readBody(request);
        if (route.startsWith("/response/")) {
          callbacks.get(route)?.push(asRecord(JSON.parse(body)));
          reply(response, { ok: true });
          return;
        }
        // Crabline owns Slack auth, channels and messages; complete the user lookup
        // it does not implement without replacing Bolt or OpenClaw's ACL checks.
        if (route === "/api/users.info") {
          const userId = new URLSearchParams(body).get("user");
          reply(response, {
            ok: true,
            user: { id: userId, team_id: "TCRABLINE", name: "command-operator" },
          });
          return;
        }
        const upstream = await fetch(new URL(route, adapter.manifest.baseUrl), {
          method: request.method,
          headers: {
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            ...(request.headers["content-type"]
              ? { "content-type": request.headers["content-type"] }
              : {}),
          },
          ...(request.method !== "GET" && request.method !== "HEAD" ? { body } : {}),
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      };
      await runQaGatewayFixture(
        async () => {
          await withServer(
            (request, response) => {
              void handleRequest(request, response).catch(() => {
                response.writeHead(500).end("Slack fixture request failed");
              });
            },
            async (baseUrl) => {
              await runQaGatewayFixture(
                async () => {
                  const manifest = adapter.manifest;
                  if (manifest.provider !== "slack") {
                    throw new Error("Expected a Slack fixture.");
                  }
                  const signingSecret = manifest.signingSecret;
                  provider = await startQaMockOpenAiServer({ modelRefs: [MODEL] });
                  const cliCommand = createQaPreparedRepoCliCommand(process.cwd());
                  const gateway = await owner.start({
                    repoRoot: process.cwd(),
                    command: cliCommand,
                    providerBaseUrl: `${provider.baseUrl}/v1`,
                    providerMode: "mock-openai",
                    primaryModel: MODEL,
                    alternateModel: MODEL,
                    controlUiEnabled: false,
                    transportBaseUrl: baseUrl,
                    transport: {
                      requiredPluginIds: adapter.requiredPluginIds,
                      createGatewayConfig: () => adapter.createGatewayConfig() as OpenClawConfig,
                    },
                    runtimeEnvPatch: {
                      ...adapter.createProviderReadinessEnv({}),
                      SLACK_API_URL: `${baseUrl}/api/`,
                      // This fixture owns its Gateway process. Doctor must repair
                      // only its isolated state, never install or control host services.
                      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
                    },
                    mutateConfig: (config) => {
                      const slack = config.channels!.slack!;
                      slack.allowFrom = [USER_ID];
                      slack.dmPolicy = "allowlist";
                      slack.channels = {
                        [CHANNEL_ID]: { users: [USER_ID], requireMention: false },
                      };
                      slack.commands = { nativeSkills: false };
                      slack.slashCommand = {
                        name: wrapper,
                        sessionPrefix: "slack:command-proof",
                        ephemeral: true,
                      };
                      if (enabled !== undefined) {
                        config.commands = { ...config.commands, native: enabled };
                      }
                      return config;
                    },
                  });
                  gatewayForEvidence = gateway;
                  if (enabled !== undefined) {
                    // Bootstrap model auth with current config, then exercise the
                    // operator's Doctor repair while the owned Gateway is stopped.
                    await gateway.restartAfterStateMutation(async ({ configPath, runtimeEnv }) => {
                      const legacy = asRecord(JSON.parse(await fs.readFile(configPath, "utf8")));
                      const slack = asRecord(asRecord(legacy.channels).slack);
                      asRecord(slack.commands).native = enabled;
                      asRecord(slack.slashCommand).enabled = enabled;
                      migration = { before: configEvidence(legacy) };
                      await fs.writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);
                      const doctor = await runUtf8CommandWithTimeout(
                        [
                          cliCommand.executablePath,
                          ...cliCommand.argsPrefix,
                          "doctor",
                          "--fix",
                          "--yes",
                          "--non-interactive",
                        ],
                        {
                          cwd: cliCommand.cwd,
                          baseEnv: {},
                          env: runtimeEnv,
                          input: "",
                          timeoutMs: 90_000,
                          maxOutputBytes: 64 * 1024,
                          killProcessTree: true,
                          requireProcessTreeExtinction: true,
                        },
                      );
                      const output = redactSensitiveText(`${doctor.stdout}\n${doctor.stderr}`, {
                        mode: "tools",
                      });
                      migration = {
                        ...migration,
                        command: "openclaw doctor --fix --yes --non-interactive",
                        exitCode: doctor.code,
                        termination: doctor.termination,
                        cleanup: doctor.cleanup,
                        output,
                        after: configEvidence(JSON.parse(await fs.readFile(configPath, "utf8"))),
                      };
                      expect(doctor.code, output).toBe(0);
                      expect(doctor.termination).toBe("exit");
                      expect(doctor.cleanup).toBe("normal");
                    });
                  }
                  await expect
                    .poll(
                      async () => {
                        const status = asRecord(
                          await gateway.call("channels.status", { probe: false }),
                        );
                        const accounts = asRecord(status.channelAccounts).slack;
                        return (
                          Array.isArray(accounts) &&
                          accounts.some((account) => asRecord(account).running)
                        );
                      },
                      { timeout: 30_000, interval: 50 },
                    )
                    .toBe(true);

                  const inbound = adapter.createInbound({
                    input: {
                      conversation: { id: CHANNEL_ID, kind: "group" },
                      senderId: USER_ID,
                      text: "Seed the Slack channel fixture.",
                    },
                  });
                  const seeded = await fetch(inbound.providerUrl, {
                    method: "POST",
                    headers: inbound.providerHeaders,
                    body: JSON.stringify(inbound.providerBody),
                  });
                  expect(seeded.ok).toBe(true);
                  const seededMessage = asRecord(asRecord(await seeded.json()).message);

                  const send = async (
                    command: string,
                    text: string,
                    userId = USER_ID,
                    action?: Record<string, unknown>,
                  ) => {
                    const callbackPath = `/response/${randomUUID()}`;
                    const responses: Record<string, unknown>[] = [];
                    callbacks.set(callbackPath, responses);
                    const slashPayload = {
                      team_id: "TCRABLINE",
                      channel_id: CHANNEL_ID,
                      channel_name: "command-proof",
                      user_id: userId,
                      user_name: "command-operator",
                      command,
                      text,
                      response_url: `${baseUrl}${callbackPath}`,
                      trigger_id: randomUUID(),
                    };
                    const body = new URLSearchParams(
                      action
                        ? {
                            payload: JSON.stringify({
                              type: "block_actions",
                              team: { id: slashPayload.team_id },
                              user: { id: userId, name: slashPayload.user_name },
                              channel: { id: CHANNEL_ID, name: slashPayload.channel_name },
                              container: {
                                type: "message",
                                channel_id: CHANNEL_ID,
                                message_ts: seededMessage.ts,
                              },
                              actions: [action],
                              response_url: slashPayload.response_url,
                              trigger_id: slashPayload.trigger_id,
                            }),
                          }
                        : slashPayload,
                    ).toString();
                    const timestamp = String(Math.floor(Date.now() / 1000));
                    const signature = createHmac("sha256", signingSecret)
                      .update(`v0:${timestamp}:${body}`)
                      .digest("hex");
                    const result = await fetch(`${gateway.baseUrl}/slack/events`, {
                      method: "POST",
                      headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        "x-slack-request-timestamp": timestamp,
                        "x-slack-signature": `v0=${signature}`,
                      },
                      body,
                    });
                    const item: CommandEvidence = {
                      eventType: action ? "block_actions" : "slash_command",
                      command,
                      text,
                      userId,
                      status: result.status,
                      acknowledgement: await result.text(),
                      responses,
                    };
                    observed.push(item);
                    if (result.ok) {
                      await expect
                        .poll(() => responses.length, { timeout: 15_000, interval: 25 })
                        .toBeGreaterThan(0);
                    }
                    return item;
                  };

                  const direct = await send(wrapper === "help" ? "/whoami" : "/help", "");
                  const wrapped = await send(
                    `/${wrapper}`,
                    wrapper === "help" ? "/whoami" : "/help",
                  );
                  const denied = await send(`/${wrapper}`, "/help", DENIED_USER_ID);
                  const unknown =
                    name === "omitted" ? await send("/not_an_openclaw_command", "") : undefined;
                  const menu = await send("/usage", "");
                  const blocks = menu.responses[0]?.blocks;
                  const elements = (Array.isArray(blocks) ? blocks : []).flatMap((block) => {
                    const items = asRecord(block).elements;
                    return Array.isArray(items) ? items.map(asRecord) : [];
                  });
                  const menuElement = elements.find((element) =>
                    Array.isArray(element.options)
                      ? element.options.some(
                          (option) => asRecord(asRecord(option).text).text === "tokens",
                        )
                      : false,
                  );
                  expect(menuElement, "usage menu exposes the tokens choice").toBeDefined();
                  const options = menuElement?.options;
                  const selected = Array.isArray(options)
                    ? options.find((option) => asRecord(asRecord(option).text).text === "tokens")
                    : undefined;
                  // Replay the actual rendered option, so this covers the menu's
                  // wire contract as well as post-ack command dispatch from actions.
                  const action = await send("/usage", "tokens", USER_ID, {
                    type: menuElement?.type,
                    action_id: menuElement?.action_id,
                    selected_option: selected,
                  });
                  const persisted = asRecord(
                    JSON.parse(await fs.readFile(gateway.configPath, "utf8")),
                  );
                  const persistedSlack = asRecord(asRecord(persisted.channels).slack);
                  const persistedSlash = asRecord(persistedSlack.slashCommand);
                  expect.soft(asRecord(persistedSlack.commands)).not.toHaveProperty("native");
                  expect.soft(persistedSlash).not.toHaveProperty("enabled");
                  expect.soft(persistedSlash.name).toBe(wrapper);
                  expect.soft(asRecord(persistedSlack.commands).nativeSkills).toBe(false);
                  expect.soft(persistedSlash.sessionPrefix).toBe("slack:command-proof");
                  expect.soft(persistedSlash.ephemeral).toBe(true);
                  if (enabled !== undefined) {
                    expect.soft(asRecord(persisted.commands).native).toBe(enabled);
                  }
                  if (unknown) {
                    expect.soft(unknown.status).toBe(404);
                    expect.soft(unknown.responses).toEqual([]);
                  }
                  for (const item of [direct, wrapped, denied, menu, action]) {
                    expect.soft(item.status, `${item.command} ${item.text}`).toBe(200);
                    expect.soft(item.responses).toHaveLength(1);
                    expect.soft(item.responses[0]?.response_type).toBe("ephemeral");
                  }
                  const expectedText = wrapper === "help" ? `User id: ${USER_ID}` : "ℹ️ Help";
                  expect
                    .soft(direct.responses[0]?.text)
                    .toEqual(expect.stringContaining(expectedText));
                  expect
                    .soft(wrapped.responses[0]?.text)
                    .toEqual(expect.stringContaining(expectedText));
                  expect.soft(wrapped.responses[0]?.text).toEqual(direct.responses[0]?.text);
                  expect
                    .soft(denied.responses[0]?.text)
                    .toEqual(expect.stringContaining("not authorized"));
                  expect.soft(action.responses[0]?.text).toBe("⚙️ Usage footer: tokens.");
                  const requests = await fetch(`${provider.baseUrl}/debug/requests`);
                  expect(requests.ok).toBe(true);
                  const modelRequests: unknown = await requests.json();
                  modelRequestCount = Array.isArray(modelRequests)
                    ? modelRequests.length
                    : undefined;
                  expect(
                    modelRequests,
                    "built-in commands must not also enqueue a model turn",
                  ).toEqual([]);
                },
                async () => {
                  if (gatewayForEvidence) {
                    await fs.writeFile(
                      path.join(evidenceDir, "gateway.log"),
                      gatewayForEvidence.readLogsSince(0),
                    );
                  }
                },
                async () => {
                  const persisted = gatewayForEvidence
                    ? asRecord(JSON.parse(await fs.readFile(gatewayForEvidence.configPath, "utf8")))
                    : {};
                  await fs.writeFile(
                    path.join(evidenceDir, "responses.json"),
                    `${JSON.stringify(
                      {
                        config: {
                          native: enabled ?? "omitted",
                          enabled: enabled ?? "omitted",
                          wrapper,
                        },
                        persisted: configEvidence(persisted),
                        migration,
                        modelRequestCount,
                        observed,
                      },
                      null,
                      2,
                    )}\n`,
                  );
                },
                () =>
                  stopQaGatewayFixture(owner, { preserveToDir: path.join(evidenceDir, "gateway") }),
              );
            },
          );
        },
        async () => {
          await provider?.stop();
        },
        () => adapter.close(),
      );
    });
  },
  180_000,
);
