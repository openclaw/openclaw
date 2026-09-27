import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Agent, request } from "node:https";
import os from "node:os";
import path from "node:path";
import {
  startFeishuServer,
  type ServerRequestEvent,
  type StartedFeishuServer,
} from "@openclaw/crabline";
import { expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../../src/test-helpers/proxy-tls-fixture.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const accounts = ["alpha", "beta"] as const;

it("joins two native Feishu accounts through the real Gateway with raw rendering, typing off and native DM post responses", async ({
  signal,
  onTestFinished,
}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-crabline-candidate-"));
  const caPath = path.join(directory, "ca.pem");
  await fs.writeFile(caPath, PROXY_FIXTURE_CERTIFICATE);
  const servers: StartedFeishuServer[] = [];
  const events = new Map<string, ServerRequestEvent[]>();
  const agent = new Agent({ ca: PROXY_FIXTURE_CERTIFICATE });
  const gatewayOwner = createQaGatewayChild();
  const mockOwner: {
    server?: Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
  } = {};
  onTestFinished(async () => {
    const errors: unknown[] = [];
    const stopped = await gatewayOwner.stop();
    errors.push(...stopped.errors);
    // Stop the consumer before its native transports, then remove their owned files.
    for (const close of [
      ...servers.map((server) => () => server.close()),
      () => mockOwner.server?.stop(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    agent.destroy();
    await fs.rm(directory, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(errors, "Candidate cleanup failed");
    }
  });
  for (const account of accounts) {
    const records: ServerRequestEvent[] = [];
    events.set(account, records);
    servers.push(
      await startFeishuServer({
        appId: account === "alpha" ? "cli_0123456789abcdef" : "cli_fedcba9876543210",
        appSecret: `synthetic-${account}-secret`,
        botOpenId: "ou_shared_bot",
        tls: { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
        recorderPath: path.join(directory, `${account}.jsonl`),
        onEvent: (event) => {
          records.push(event);
        },
      }),
    );
  }
  const stage = (account: string, name: string) =>
    events
      .get(account)!
      .filter((event) => (event.body as { stage?: string } | undefined)?.stage === name);
  const mock = await startQaMockOpenAiServer();
  mockOwner.server = mock;
  const modelRef = "mock-openai/gpt-5.6-luna";
  // The built Gateway admits bundled plugins from its owning package root.
  // Snapshot the declared entry before startup to bind the loaded code to this build.
  const builtPluginRoot = path.join(await fs.realpath(repoRoot), "dist/extensions/feishu");
  const builtPackage = JSON.parse(
    await fs.readFile(path.join(builtPluginRoot, "package.json"), "utf8"),
  ) as { name: string; openclaw: { extensions: string[] } };
  expect(builtPackage.name).toBe("@openclaw/feishu");
  expect(builtPackage.openclaw.extensions).toEqual([
    expect.stringMatching(/^\.\/index\.(?:c|m)?js$/u),
  ]);
  const builtEntry = await fs.realpath(
    path.resolve(builtPluginRoot, builtPackage.openclaw.extensions[0]!),
  );
  expect(path.dirname(builtEntry)).toBe(builtPluginRoot);
  const builtEntryHash = createHash("sha256")
    .update(await fs.readFile(builtEntry))
    .digest("hex");
  const gateway = await gatewayOwner.start({
    repoRoot,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    transportBaseUrl: mock.baseUrl,
    providerMode: "mock-openai",
    primaryModel: modelRef,
    alternateModel: modelRef,
    forcedRuntime: "openclaw",
    controlUiEnabled: false,
    enabledPluginIds: ["feishu"],
    runtimeEnvPatch: { NODE_EXTRA_CA_CERTS: caPath },
    mutateConfig: (cfg) => ({
      ...cfg,
      logging: { ...cfg.logging, level: "debug", consoleLevel: "debug" },
      session: { ...cfg.session, dmScope: "per-account-channel-peer" },
      channels: {
        ...cfg.channels,
        feishu: {
          enabled: true,
          connectionMode: "websocket",
          renderMode: "raw",
          typingIndicator: false,
          resolveSenderNames: false,
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: Object.fromEntries(
            accounts.map((account, index) => [
              account,
              {
                appId: servers[index]!.manifest.appId,
                appSecret: servers[index]!.manifest.appSecret,
                domain: servers[index]!.manifest.baseUrl,
              },
            ]),
          ),
        },
      },
    }),
  });
  const deadline = Date.now() + 60_000;
  const wait = async (predicate: () => boolean) => {
    while (!predicate()) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error(`Native candidate did not complete. ${gateway.logs().slice(-12_000)}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  };
  await wait(() => accounts.every((account) => stage(account, "websocket.connected").length === 1));
  const loaded = [...gateway.logs().matchAll(/\[plugins\] loading feishu from ([^\r\n]+)/gu)]
    .at(-1)?.[1]
    ?.trim();
  if (!loaded) {
    throw new Error("Gateway did not report its actual Feishu executable entry");
  }
  expect(await fs.realpath(loaded)).toBe(builtEntry);
  const entryHash = createHash("sha256")
    .update(await fs.readFile(loaded))
    .digest("hex");
  expect(entryHash).toBe(builtEntryHash);
  const sourceHash = createHash("sha256")
    .update(await fs.readFile(path.join(repoRoot, "extensions/feishu/index.ts")))
    .digest("hex");
  const cursorResponse = await fetch(`${mock.baseUrl}/debug/request-cursor`, { signal });
  expect(cursorResponse.ok).toBe(true);
  const { cursor } = (await cursorResponse.json()) as { cursor: number };
  const replies = ["中文回复甲", "中文回复乙"];
  for (const [index, account] of accounts.entries()) {
    const server = servers[index]!;
    const body = JSON.stringify({
      messageId: "om_shared_inbound",
      eventId: "shared-event",
      chatId: "oc_shared_chat",
      senderId: "ou_shared_peer",
      text: `中文入口 ${account}。reply exactly \`${replies[index]}\``,
      fragments: 3,
      fragmentOrder: [2, 0, 1],
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        server.manifest.endpoints.adminInboundUrl,
        {
          agent,
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-crabline-admin-token": server.manifest.adminToken,
          },
        },
        (response) => {
          response.resume();
          response.once("error", reject);
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.once("error", reject);
      req.setTimeout(5_000, () => req.destroy(new Error("Admin ingress timed out")));
      req.end(body);
    });
    expect(status).toBe(200);
    await wait(
      () =>
        stage(account, "outbound.accepted").length > 0 && stage(account, "sdk.ack").length === 1,
    );
    expect(stage(account, "inbound.admitted")).toHaveLength(1);
    expect(stage(account, "websocket.delivery")[0]!.body).toMatchObject({
      delivered: true,
      fragments: 3,
    });
    expect(stage(account, "sdk.ack")[0]!.body).toMatchObject({
      code: 200,
      messageId: "om_shared_inbound",
    });
    expect(stage(account, "outbound.accepted")).toHaveLength(1);
    const outbound = stage(account, "outbound.accepted")[0]!.body as {
      message: { msg_type: string; chat_id: string; parent_id?: string; body: { content: string } };
    };
    expect(outbound.message.msg_type).toBe("post");
    expect(outbound.message.chat_id).toBe("oc_shared_chat");
    expect(outbound.message.parent_id).toBeUndefined();
    expect(outbound.message.body.content).toContain(replies[index]);
    expect(outbound.message.body.content).not.toContain(replies[1 - index]);
  }
  const response = await fetch(`${mock.baseUrl}/debug/requests?after=${cursor}`, { signal });
  expect(response.ok).toBe(true);
  const requests = (await response.json()) as MockOpenAiRequestSnapshot[];
  for (const account of accounts) {
    const own = requests.filter((entry) => entry.allInputText.includes(`中文入口 ${account}`));
    expect(own).toHaveLength(1);
    expect(own[0]!.outcome).toBe("success");
    expect(own[0]!.allInputText).not.toContain(
      `中文入口 ${account === "alpha" ? "beta" : "alpha"}`,
    );
  }
  // The import-attempt line is identity evidence only; native replies above prove execution.
  console.log(
    JSON.stringify({
      proof: "feishu-native-gateway-candidate",
      renderMode: "raw",
      typingIndicator: false,
      archiveSha256: process.env.CRABLINE_CANDIDATE_ARCHIVE_SHA256,
      packageSha256: process.env.CRABLINE_CANDIDATE_PACKAGE_SHA256,
      feishuEntrySha256: entryHash,
      feishuBuiltEntrySha256: builtEntryHash,
      feishuSourceSha256: sourceHash,
      accounts: accounts.map((account) => ({
        account,
        admitted: stage(account, "inbound.admitted").length,
        ack200: stage(account, "sdk.ack").length,
        nativePosts: stage(account, "outbound.accepted").length,
      })),
      unqualified: [
        "default-cardkit",
        "typing",
        "webhook",
        "media",
        "cancellation",
        "published-consumer",
        "live-account",
      ],
    }),
  );
}, 180_000);
