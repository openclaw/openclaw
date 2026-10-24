import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveOpenClawCrablineChannelDriverSelection,
  type ServerRequestEvent,
  type StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import {
  createQaBusState,
  createQaCrablineTransportAdapter,
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaPluginEntryObservation } from "../../../helpers/qa-plugin-entry-observation.js";
import { json, pluginIdentity, sha256 } from "./candidate-test-support.js";

let startedAdapter: StartedOpenClawCrablineAdapter | undefined;
let retainedResources = false;
function capturedAdapter() {
  return startedAdapter;
}
vi.mock("@openclaw/crabline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/crabline")>();
  return {
    ...actual,
    // Capture the public object returned to the unchanged transport. Arguments, observer,
    // native events and return value all pass through without replacement.
    startOpenClawCrablineAdapter: async (
      ...args: Parameters<typeof actual.startOpenClawCrablineAdapter>
    ) => {
      const adapter = await actual.startOpenClawCrablineAdapter(...args);
      startedAdapter = adapter;
      return adapter;
    },
  };
});

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
type NativeRecord = ServerRequestEvent & { accepted?: boolean };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for candidate proof`);
  }
  return value;
}

async function candidateIdentity() {
  const root = await fs.realpath(required("CRABLINE_CANDIDATE_ROOT"));
  const rows: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).toSorted()) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(file);
        rows.push(
          `${path.relative(root, file).split(path.sep).join("/")}\0${sha256(bytes)}\0${bytes.length}\n`,
        );
      } else {
        throw new Error("Candidate package contains a non-regular entry");
      }
    }
  }
  await visit(root);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    name: string;
    exports: { ".": { import: string; types: string } };
  };
  expect(pkg.name).toBe("@openclaw/crabline");
  const exports: Record<string, string> = {};
  for (const [kind, relative] of Object.entries(pkg.exports["."])) {
    const file = await fs.realpath(path.resolve(root, relative));
    expect(file.startsWith(`${root}${path.sep}`)).toBe(true);
    exports[kind] = sha256(await fs.readFile(file));
  }
  const identity = {
    archive: sha256(await fs.readFile(required("CRABLINE_CANDIDATE_ARCHIVE"))),
    content: sha256(rows.toSorted().join("")),
    files: rows.length,
    exports,
  };
  expect(identity.archive).toBe(required("CRABLINE_CANDIDATE_ARCHIVE_SHA256"));
  expect(identity.content).toBe(required("CRABLINE_CANDIDATE_PACKAGE_SHA256"));
  return identity;
}

const slackRuntimeIdentity = () => pluginIdentity(repoRoot, "slack");

// These are separate test cells: a nonstreaming callback pass never qualifies defaults.
it.for(["nonstreaming", "default-streaming diagnostic"] as const)(
  "runs a public Slack callback roundtrip through the real Gateway: %s",
  { timeout: 180_000 },
  async (mode, { signal, onTestFinished }) => {
    if (retainedResources) {
      throw new Error("Prior candidate resources remain owned; do not start another fixture");
    }
    const identity = await candidateIdentity();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slack-crabline-candidate-"));
    const gatewayOwner = createQaGatewayChild();
    retainedResources = true;
    const fixture = new AbortController();
    const assertActive = () => {
      signal.throwIfAborted();
      fixture.signal.throwIfAborted();
    };
    const bus = createQaBusState();
    let transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    let gateway: Awaited<ReturnType<typeof gatewayOwner.start>> | undefined;
    let stopped = false;
    let transportClosed = false;
    let providerClosed = false;
    let runtimeIdentity: Awaited<ReturnType<typeof slackRuntimeIdentity>> | undefined;
    const recorderFile = path.join(directory, "artifacts/crabline/slack-provider-server.jsonl");
    const records = async (): Promise<NativeRecord[]> => {
      const contents = await fs.readFile(recorderFile, "utf8");
      return contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NativeRecord);
    };
    const outbound = () =>
      bus.getSnapshot().messages.filter((message) => message.direction === "outbound");
    const cursors = async (baseUrl: string) => ({
      modelCursor: (await json<{ cursor: number }>(`${baseUrl}/debug/request-cursor`, signal))
        .cursor,
      recorderCursor: (await records()).length,
      busCursor: outbound().length,
    });
    const runBody = async () => {
      assertActive();
      startedAdapter = undefined;
      const activeTransport = await createQaCrablineTransportAdapter({
        outputDir: directory,
        selection: resolveOpenClawCrablineChannelDriverSelection({ channel: "slack" }),
        state: bus,
      });
      transport = activeTransport;
      assertActive();
      const adapter = capturedAdapter();
      if (!adapter || !adapter.bindGateway || adapter.manifest.provider !== "slack") {
        throw new Error("Installed public Slack adapter is missing its callback contract");
      }
      const manifest = adapter.manifest;
      const sendProviderInbound = async (
        input: Parameters<typeof adapter.createInbound>[0]["input"],
      ) => {
        const inbound = adapter.createInbound({ input });
        // Register reply correlation before the public callback can produce a reply.
        activeTransport.buildAgentDelivery({ target: inbound.qaTarget });
        const response = await fetch(inbound.providerUrl, {
          method: "POST",
          headers: inbound.providerHeaders,
          body: JSON.stringify(inbound.providerBody),
          signal: AbortSignal.any([signal, fixture.signal]),
        });
        const body: unknown = await response.json();
        expect(response.ok).toBe(true);
        if (!isRecord(body) || !isRecord(body.message) || typeof body.message.ts !== "string") {
          throw new Error("Crabline Slack inbound omitted its native message timestamp");
        }
        return { id: body.message.ts };
      };
      const probe = await adapter.probe();
      if (!isRecord(probe) || typeof probe.user_id !== "string") {
        throw new Error("Slack auth.test did not return its native bot identity");
      }
      const botUserId = probe.user_id;
      const nativeMessages = async (channel: string, threadId?: string) => {
        const method = threadId ? "conversations.replies" : "conversations.history";
        const history = await json<{
          ok: boolean;
          messages: Array<{ ts: string; text: string; user: string; thread_ts?: string }>;
        }>(`${manifest.endpoints.apiRoot}${method}`, signal, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${manifest.botToken}`,
          },
          body: JSON.stringify({ channel, ...(threadId ? { ts: threadId } : {}) }),
        });
        expect(history.ok).toBe(true);
        return history.messages;
      };
      assertActive();
      mock = await startQaMockOpenAiServer();
      const requestUrl = `${mock.baseUrl}/debug/requests?after=`;
      const modelRequests = (cursor: number) =>
        json<MockOpenAiRequestSnapshot[]>(requestUrl + cursor, signal);
      assertActive();
      const channelConfig = transport.createGatewayConfig({ baseUrl: mock.baseUrl });
      runtimeIdentity = await slackRuntimeIdentity();
      const entryObservation = await createQaPluginEntryObservation({
        directory,
        entry: runtimeIdentity.entry,
      });
      assertActive();
      gateway = await gatewayOwner.start({
        repoRoot,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        transportBaseUrl: mock.baseUrl,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna",
        forcedRuntime: "openclaw",
        controlUiEnabled: false,
        enabledPluginIds: [...transport.requiredPluginIds],
        runtimeEnvPatch: transport.createRuntimeEnvPatch(),
        runtimePreloads: [entryObservation.preloadUrl],
        mutateConfig: (cfg) => ({
          ...cfg,
          logging: { ...cfg.logging, level: "debug", consoleLevel: "debug" },
          agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, typingMode: "never" } },
          messages: { ...cfg.messages, ...channelConfig.messages },
          channels: {
            ...cfg.channels,
            ...channelConfig.channels,
            slack: {
              ...channelConfig.channels?.slack,
              // Typing is separate; leave streaming untouched in its diagnostic.
              typingReaction: "",
              replyToMode: "off",
              accounts: {
                default: {
                  webhookPath: "/candidate/slack/events",
                  ...(mode === "nonstreaming"
                    ? { streaming: { mode: "off" as const, nativeTransport: false } }
                    : {}),
                },
              },
            },
          },
        }),
      });
      assertActive();
      await transport.waitReady({ gateway });
      assertActive();
      await entryObservation.verify(gateway.pid, runtimeIdentity.entrySha256);
      const first = await cursors(mock.baseUrl);
      const unboundMarker = "p03-unbound-no-replay";
      assertActive();
      const unbound = await sendProviderInbound({
        conversation: { id: "D0000000001", kind: "direct" },
        senderId: "U0000000001",
        text: unboundMarker,
      });
      expect(unbound.id).toMatch(/^\d+\.\d+$/u);
      expect(await nativeMessages("D0000000001")).toEqual([
        expect.objectContaining({ ts: unbound.id, text: unboundMarker, user: "U0000000001" }),
      ]);
      await transport.waitForNoOutbound({ sinceIndex: first.busCursor });
      expect(await modelRequests(first.modelCursor)).toEqual([]);
      // This is P03's direct public binding. Automatic Gateway lifecycle wiring belongs to P04.
      assertActive();
      await adapter.bindGateway({
        baseUrl: gateway.baseUrl,
        cfg: gateway.cfg,
        signal: fixture.signal,
      });
      let parentId: string | undefined;
      for (const kind of mode === "nonstreaming"
        ? (["dm", "thread"] as const)
        : (["dm"] as const)) {
        const marker = `p03-${mode}-${kind}`;
        const reply = `callback-${kind}-reply`;
        const cursor = await cursors(mock.baseUrl);
        assertActive();
        const inbound = await sendProviderInbound({
          conversation: { id: "D0000000002", kind: "direct" },
          senderId: "U0000000001",
          text: `${marker}: reply exactly \`${reply}\``,
          ...(kind === "thread" ? { threadId: parentId } : {}),
        });
        expect(inbound.id).toMatch(/^\d+\.\d+$/u);
        const normalized = await transport.waitForOutbound({
          conversation: { id: "D0000000002", kind: "direct" },
          sinceIndex: cursor.busCursor,
          textIncludes: reply,
          ...(kind === "thread" ? { threadId: parentId } : {}),
          timeoutMs: 45_000,
        });
        expect(normalized).toMatchObject({ text: reply, accountId: "default" });
        expect(normalized.id).not.toBe("");
        const requests = await modelRequests(cursor.modelCursor);
        const ownRequests = requests.filter((entry) => entry.allInputText.includes(marker));
        expect(ownRequests).toMatchObject([{ outcome: "success" }]);
        expect(requests.every((entry) => !entry.allInputText.includes(unboundMarker))).toBe(true);
        const posts = (await records())
          .slice(cursor.recorderCursor)
          .filter(
            (event) =>
              event.method === "POST" &&
              event.path.endsWith("/api/chat.postMessage") &&
              event.accepted === true &&
              isRecord(event.body) &&
              event.body.text === reply,
          );
        expect(posts).toHaveLength(1);
        expect(posts[0]!.body).toMatchObject({
          channel: "D0000000002",
          ...(kind === "thread" ? { thread_ts: parentId } : {}),
        });
        const history = await nativeMessages(
          "D0000000002",
          kind === "thread" ? parentId : undefined,
        );
        const nativeReply = history.find((message) => message.text === reply);
        expect(nativeReply).toMatchObject({
          ts: expect.stringMatching(/^\d+\.\d+$/u),
          user: botUserId,
        });
        expect(nativeReply?.thread_ts).toBe(kind === "thread" ? parentId : undefined);
        expect(normalized.threadId).toBe(kind === "thread" ? parentId : undefined);
        parentId ??= inbound.id;
      }
      const allRequests = await modelRequests(first.modelCursor);
      expect(allRequests.every((entry) => !entry.allInputText.includes(unboundMarker))).toBe(true);
    };
    let body: Promise<void> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= runQaGatewayFixture(
        async () => {
          expect(await candidateIdentity()).toEqual(identity);
          if (runtimeIdentity) {
            expect(await slackRuntimeIdentity()).toEqual(runtimeIdentity);
          }
        },
        () => fixture.abort(),
        () =>
          stopQaGatewayFixture({
            stop: async () => {
              const result = await gatewayOwner.stop();
              stopped =
                result.process === "confirmed-stopped" || result.process === "never-spawned";
              if (!stopped && result.errors.length === 0) {
                throw new Error("Gateway process stop is unconfirmed; retain downstream resources");
              }
              return result;
            },
          }),
        async () => {
          if (!stopped) {
            return;
          }
          // Stop the Gateway before joining startup; it may still return an owned adapter.
          await body?.catch(() => undefined);
          if (transport) {
            await transport.cleanupAfterGatewayStop();
          } else {
            await capturedAdapter()?.close();
          }
          transportClosed = true;
        },
        async () => {
          if (stopped && transportClosed) {
            await mock?.stop();
            providerClosed = true;
          }
        },
        () => {
          retainedResources = !(stopped && transportClosed && providerClosed);
        },
      ));
    onTestFinished(cleanup);
    const onAbort = () => {
      void cleanup().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) {
        await cleanup();
        signal.throwIfAborted();
      }
      await runQaGatewayFixture(() => (body = runBody()), cleanup);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
);
