import type { LookupAddress } from "node:dns";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { Agent, EnvHttpProxyAgent, FormData, ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../extensions/slack/api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext } from "../src/channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "../src/gateway/server-methods/agent-runtime-authority.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../src/gateway/server-methods/types.js";
import type { DedupeEntry } from "../src/gateway/server-shared.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { getImageMetadata } from "../src/media/media-services.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { observeFsSafeRootMoves } from "./helpers/fs-safe-root.test-support.js";
import { createSolidPngBuffer } from "./helpers/image-fixtures.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";

const interleaving = vi.hoisted(() => ({
  lookup: undefined as ((hostname: string) => Promise<LookupAddress[]>) | undefined,
  afterMime: undefined as (() => void) | undefined,
  afterGatewayMirror: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) =>
      interleaving.lookup ? interleaving.lookup(args[0]) : actual.lookup(...args),
  };
});

vi.mock("@openclaw/media-core/mime", async (original) => {
  const actual = await original<typeof import("@openclaw/media-core/mime")>();
  return {
    ...actual,
    detectMime: async (...args: Parameters<typeof actual.detectMime>) => {
      const result = await actual.detectMime(...args);
      interleaving.afterMime?.();
      return result;
    },
  };
});

vi.mock("../src/infra/outbound/source-reply-mirror.js", async (original) => {
  const actual = await original<typeof import("../src/infra/outbound/source-reply-mirror.js")>();
  return {
    ...actual,
    mirrorDeliveredSourceReplyToTranscript: async (
      ...args: Parameters<typeof actual.mirrorDeliveredSourceReplyToTranscript>
    ) => {
      const result = await actual.mirrorDeliveredSourceReplyToTranscript(...args);
      if (args[0].action === "download-file" && interleaving.afterGatewayMirror) {
        await interleaving.afterGatewayMirror();
      }
      return result;
    },
  };
});

const CURRENT_CHANNEL = "C9876543210";
const TARGET_CHANNEL = "C0123456789";
const FILE_ID = "F0123456789";
const THREAD = "1234567890.123456";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const PRESERVED = "preexisting attachment must remain";
let sequence = 0;
let imageBytes: Buffer | undefined;

type Phase =
  | "metadata"
  | "refresh"
  | "dns"
  | "redirect-dns"
  | "store-open"
  | "body"
  | "mime"
  | "prepublication"
  | "published"
  | "image-read"
  | "result"
  | "gateway-mirror";
type Revocation = "plugin" | "turn" | "claim" | "signal";
type DownloadResult = Awaited<ReturnType<typeof dispatchChannelMessageAction>>;
type FixtureOptions = {
  origin?: "global" | "bundled";
  trusted?: boolean;
  legacy?: boolean;
  entry?: "tool" | "direct";
  currentOnly?: boolean;
  currentProvider?: string;
  disabled?: boolean;
  userToken?: boolean;
  govSlack?: boolean;
  image?: boolean;
  body?: Buffer;
  contentType?: string;
  file?: Record<string, unknown>;
  refreshedFile?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  redirect?: string;
  expired?: boolean;
  maxBytes?: number;
  dnsAddress?: string;
  phase?: Phase;
  revoke?: Revocation;
  replaceResultFile?: boolean;
};
type RequestRecord = { url: URL; authorization?: string; body: string };
type GatewayResponse = {
  ok: boolean;
  payload?: unknown;
  error?: Parameters<RespondFn>[2];
  meta?: Parameters<RespondFn>[3];
};
type GatewayMirrorSnapshot = {
  artifacts: string[];
  responses: number;
  cacheWrites: number;
};

function createOriginatingRun(currentProvider: string, currentChannelId: string) {
  const operationalRunInstance = createOperationalRunInstanceRef(`slack-download-${++sequence}`);
  const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const sessionKey = `agent:main:${currentProvider}:channel:${currentChannelId}`;
  const toolContext = {
    currentChannelProvider: currentProvider,
    currentChannelId,
    currentMessagingTarget: `channel:${currentChannelId}`,
    currentChatType: "channel" as const,
    // An ambient thread does not add an explicit file-share requirement.
    currentThreadTs: "9999999999.999999",
  };
  const capability = mintMessageActionTurnCapability({
    agentId: "main",
    runId: operationalRunInstance.runId,
    sessionKey,
    requesterAccountId: "default",
    requesterSenderId: "synthetic-requester",
    toolContext,
  });
  const messageActionContext = resolveMessageActionTurnCapability({
    token: capability,
    agentId: "main",
    runId: operationalRunInstance.runId,
    sessionKey,
  });
  if (!messageActionContext) {
    throw new Error("Missing admitted download turn context");
  }
  const client = {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegated },
        messageActionContext: { ...messageActionContext, turnCapability: capability },
      },
    },
  } as GatewayClient;
  const validate = createAgentRuntimeApprovalAuthorityValidator();
  const assert = createAgentRuntimeAuthorityGuard(
    client,
    {
      validateAgentRuntimeApprovalAuthority: validate,
    } as GatewayRequestContext,
    () => {},
  ).commitGuard;
  if (!assert) {
    throw new Error("Missing originating download authority");
  }
  assert();
  return {
    assert,
    client,
    validate,
    toolContext,
    options: {
      agentId: "main",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId: operationalRunInstance.runId,
      messageActionTurnCapability: capability,
      ...toolContext,
    },
    wrap: (tool: ReturnType<typeof createMessageTool>) =>
      wrapToolWithGatewayCallerIdentity(tool, {
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
      }),
    revoke: (kind: Revocation) => {
      if (kind === "claim") {
        releaseAgentRunDelegatedAuthority(delegated);
      } else {
        revokeMessageActionTurnCapability(capability);
      }
    },
    dispose: () => {
      revokeMessageActionTurnCapability(capability);
      releaseAgentRunDelegatedAuthority(delegated);
    },
  };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? await filesUnder(target) : [target];
    }),
  );
  return files.flat().toSorted();
}

function payloadPath(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("path" in payload) ||
    typeof payload.path !== "string"
  ) {
    throw new Error(`Expected a downloaded attachment, received ${JSON.stringify(payload)}`);
  }
  return payload.path;
}

function resultPath(result: DownloadResult): string {
  return payloadPath(result?.details);
}

afterEach(() => {
  interleaving.lookup = undefined;
  interleaving.afterMime = undefined;
  interleaving.afterGatewayMirror = undefined;
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

// Trust provenance is covered by the installer/loader suites. This fixture uses
// their attested registration shape and runs the actual Slack action and media path.
async function withDownloadFixture(
  options: FixtureOptions,
  check: (fixture: {
    invoke: () => Promise<DownloadResult>;
    invokeGateway: () => Promise<GatewayResponse>;
    gatewayResponses: GatewayResponse[];
    gatewayCacheWrites: DedupeEntry[];
    gatewayMirrorSnapshots: GatewayMirrorSnapshot[];
    requests: RequestRecord[];
    terminalRequests: URL[];
    phases: Set<Phase>;
    mediaDir: string;
    preservedPath: string;
    displacedPath: string;
    body: Buffer;
    token: string;
    bodyStarted: Promise<void>;
    binaryRequests: () => RequestRecord[];
    assertPreserved: () => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "slack-download-proof-" },
    async (state) => {
      const run = createOriginatingRun(options.currentProvider ?? "slack", CURRENT_CHANNEL);
      try {
        const source = new AbortController();
        const token = `${options.userToken ? "xoxp" : "xoxb"}-synthetic-download-${sequence}`;
        const mediaDir = state.statePath("media", "inbound");
        await fs.mkdir(mediaDir, { recursive: true });
        if (process.platform !== "win32") {
          await fs.chmod(mediaDir, 0o755);
        }
        const preservedPath = path.join(mediaDir, "existing.txt");
        const displacedPath = state.statePath("displaced-output");
        await fs.writeFile(preservedPath, PRESERVED);
        const body =
          options.body ??
          (options.image
            ? (imageBytes ??= createSolidPngBuffer(2600, 1300, { r: 40, g: 80, b: 120 }))
            : PDF);
        const contentType =
          options.contentType ?? (options.image ? "image/png" : "application/pdf");
        const fileHost = options.govSlack ? "files.slack-gov.com" : "files.slack.com";
        const file = {
          id: FILE_ID,
          name: options.image ? "picture.png" : "paper.pdf",
          mimetype: contentType,
          url_private_download: `https://${fileHost}/file`,
          channels: [options.currentOnly ? CURRENT_CHANNEL : TARGET_CHANNEL],
          ...options.file,
        };
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { imageMaxDimensionPx: 600 },
            entries: { main: { workspace: state.workspaceDir } },
          },
          channels: {
            slack: {
              enabled: true,
              botToken: options.userToken ? `xoxb-unused-${sequence}` : token,
              ...(options.userToken ? { userToken: token } : {}),
              groupPolicy: "allowlist",
              channels: {
                [CURRENT_CHANNEL]: { enabled: true },
                [TARGET_CHANNEL]: { enabled: options.disabled !== true },
              },
              ...(options.maxBytes ? { mediaMaxMb: options.maxBytes / (1024 * 1024) } : {}),
              accounts: { default: {}, other: { botToken: `xoxb-other-${sequence}` } },
            },
          },
        };
        const owner = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: {} as PluginRuntime,
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({
          id: "slack",
          origin: options.origin ?? "global",
          trustedOfficialInstall: options.trusted !== false && options.origin !== "bundled",
        });
        const phases = new Set<Phase>();
        const bodyStarted = createDeferred();
        let revoked = false;
        const hit = (phase: Phase) => {
          phases.add(phase);
          if (phase === "body") {
            bodyStarted.resolve();
          }
          if (options.phase !== phase || revoked) {
            return;
          }
          revoked = true;
          if (options.revoke === "signal") {
            source.abort(new Error("synthetic download canceled"));
          } else if (!options.revoke || options.revoke === "plugin") {
            record.enabled = false;
          } else {
            run.revoke(options.revoke);
          }
        };
        const actions = slackPlugin.actions;
        if (!actions?.handleAction) {
          throw new Error("Missing Slack message actions");
        }
        const handleAction = actions.handleAction;
        owner.registry.plugins.push(record);
        owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
          plugin: {
            ...slackPlugin,
            status: undefined,
            actions: {
              ...actions,
              readAuthorityActions: options.legacy ? undefined : actions.readAuthorityActions,
              handleAction: async (ctx) => {
                const result = await handleAction(ctx);
                if (options.replaceResultFile) {
                  const output = resultPath(result);
                  await fs.rename(output, displacedPath);
                  await fs.writeFile(output, "replacement must remain");
                }
                hit("result");
                return result;
              },
            },
          },
        });
        setActivePluginRegistry(owner.registry);
        setRuntimeConfigSnapshot(cfg, cfg);
        const requests: RequestRecord[] = [];
        const terminalRequests: URL[] = [];
        const fixtureErrors: unknown[] = [];
        const pending: Promise<unknown>[] = [];
        const gatewayResponses: GatewayResponse[] = [];
        const gatewayCacheWrites: DedupeEntry[] = [];
        const gatewayMirrorSnapshots: GatewayMirrorSnapshot[] = [];
        const dedupe = new Map<string, DedupeEntry>();
        const cacheResult = dedupe.set.bind(dedupe);
        vi.spyOn(dedupe, "set").mockImplementation((key, value) => {
          gatewayCacheWrites.push({ ...value });
          return cacheResult(key, value);
        });
        // Same manual-handler context as send.test.ts, with its real run validator.
        const gatewayContext = {
          dedupe,
          getRuntimeConfig: () => cfg,
          validateAgentRuntimeApprovalAuthority: run.validate,
        } as GatewayRequestContext;
        const binaryRequests = () =>
          requests.filter(({ url }) => !url.pathname.startsWith("/api/"));
        let fileInfoCalls = 0;
        let heldResponse: ServerResponse | undefined;
        const finishBody = () => {
          const response = heldResponse;
          heldResponse = undefined;
          response?.end(body.subarray(16));
        };
        const realOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          if (
            typeof args[0] === "string" &&
            args[0].startsWith(`${mediaDir}${path.sep}`) &&
            args[1] === "wx"
          ) {
            hit("store-open");
            const write = handle.writeFile.bind(handle);
            vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
              await write(...writeArgs);
              hit("body");
              if (options.revoke !== "signal") {
                finishBody();
              }
            });
          }
          return handle;
        });
        observeFsSafeRootMoves(mediaDir, (target) => {
          if (path.dirname(target) === mediaDir && !target.endsWith(".tmp")) {
            hit("published");
          }
        });
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: (operation, target) => {
            if (
              operation === "move" &&
              path.dirname(target) === mediaDir &&
              !target.endsWith(".tmp")
            ) {
              hit("prepublication");
            }
          },
          afterOpen: (filePath, handle) => {
            if (options.image && path.dirname(filePath) === mediaDir && filePath.endsWith(".png")) {
              const read = handle.readFile.bind(handle);
              vi.spyOn(handle, "readFile").mockImplementation(async (...args) => {
                const bytes = await read(...args);
                hit("image-read");
                return bytes;
              });
            }
          },
        });
        interleaving.afterMime = () => hit("mime");
        interleaving.afterGatewayMirror =
          options.phase === "gateway-mirror"
            ? async () => {
                gatewayMirrorSnapshots.push({
                  artifacts: (await filesUnder(mediaDir)).filter(
                    (artifact) => artifact !== preservedPath,
                  ),
                  responses: gatewayResponses.length,
                  cacheWrites: gatewayCacheWrites.length,
                });
                hit("gateway-mirror");
              }
            : undefined;
        interleaving.lookup = async (hostname) => {
          if (
            !["files.slack.com", "downloads.slack-edge.com", "files.slack-gov.com"].includes(
              hostname,
            )
          ) {
            throw new Error(`Unexpected fixture DNS lookup: ${hostname}`);
          }
          await Promise.resolve();
          hit(binaryRequests().length ? "redirect-dns" : "dns");
          return [{ address: options.dnsAddress ?? "93.184.216.34", family: 4 }];
        };
        for (const key of [
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "https_proxy",
          "http_proxy",
          "ALL_PROXY",
          "all_proxy",
        ]) {
          vi.stubEnv(key, undefined);
        }
        vi.stubEnv(
          "SLACK_API_URL",
          options.govSlack ? "https://slack-gov.com/api/" : "https://slack.com/api/",
        );
        const realFetch = globalThis.fetch.bind(globalThis);
        try {
          await withServer(
            (request, response) => {
              void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const routed = new URL(request.url!, "http://fixture.invalid");
                const url = new URL(`https:/${routed.pathname}${routed.search}`);
                requests.push({
                  url,
                  authorization: request.headers.authorization,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
                if (url.pathname === "/api/conversations.info") {
                  response.setHeader("content-type", "application/json");
                  response.end(
                    JSON.stringify({
                      ok: true,
                      channel: { id: TARGET_CHANNEL, name: "allowed", is_channel: true },
                    }),
                  );
                } else if (url.pathname === "/api/files.info") {
                  fileInfoCalls += 1;
                  hit(fileInfoCalls === 1 ? "metadata" : "refresh");
                  const refreshed =
                    options.refreshedFile === undefined ? file : options.refreshedFile;
                  response.setHeader("content-type", "application/json");
                  response.end(
                    JSON.stringify({ ok: true, file: fileInfoCalls === 1 ? file : refreshed }),
                  );
                } else if (options.expired && url.pathname === "/file") {
                  response.writeHead(403);
                  response.end("expired fixture URL");
                } else if (options.redirect && url.pathname === "/file") {
                  response.writeHead(302, { location: options.redirect });
                  response.end();
                } else {
                  response.writeHead(200, { "content-type": contentType });
                  if (options.phase === "body") {
                    heldResponse = response;
                    response.write(body.subarray(0, 16));
                  } else {
                    response.write(body);
                    response.end();
                  }
                }
              })().catch((error: unknown) => {
                fixtureErrors.push(error);
                response.destroy(error instanceof Error ? error : undefined);
              });
            },
            async (baseUrl) => {
              const routeFetch = async (
                input: RequestInfo | URL,
                init?: RequestInit & { dispatcher?: unknown },
              ) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                terminalRequests.push(url);
                if (
                  url.protocol !== "https:" ||
                  ![
                    "slack.com",
                    "slack-gov.com",
                    "files.slack.com",
                    "downloads.slack-edge.com",
                    "files.slack-gov.com",
                  ].includes(url.hostname)
                ) {
                  const error = new Error(`Unexpected terminal fixture URL: ${url.origin}`);
                  fixtureErrors.push(error);
                  throw error;
                }
                const expectedPath = ["slack.com", "slack-gov.com"].includes(url.hostname)
                  ? ["/api/conversations.info", "/api/files.info"].includes(url.pathname)
                  : ["/file", "/fresh", "/redirect"].includes(url.pathname);
                if (!expectedPath) {
                  const error = new Error(`Unexpected terminal fixture path: ${url.pathname}`);
                  fixtureErrors.push(error);
                  throw error;
                }
                const { dispatcher: _dispatcher, ...wireInit } = init ?? {};
                return await realFetch(
                  `${baseUrl}/${url.host}${url.pathname}${url.search}`,
                  wireInit,
                );
              };
              vi.stubGlobal("fetch", routeFetch);
              vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
                Agent,
                EnvHttpProxyAgent,
                FormData,
                ProxyAgent,
                fetch: routeFetch,
              });
              const tool = run.wrap(
                createMessageTool({
                  ...run.options,
                  config: cfg,
                  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
                  resolveCommandSecretRefsViaGateway: async ({ config }) => ({
                    resolvedConfig: config,
                    diagnostics: [],
                    targetStatesByPath: {},
                    hadUnresolvedTargets: false,
                  }),
                }),
              );
              const actionParams = (): Record<string, unknown> => ({
                fileId: FILE_ID,
                ...(!options.currentOnly ? { channelId: TARGET_CHANNEL } : {}),
                ...options.params,
              });
              const invoke = () => {
                const params = actionParams();
                const context: ChannelMessageActionContext = {
                  cfg,
                  channel: "slack",
                  action: "download-file",
                  params,
                  accountId: typeof params.accountId === "string" ? params.accountId : "default",
                  requesterAccountId: "default",
                  requesterSenderId: "synthetic-requester",
                  conversationReadOrigin:
                    options.entry === "direct" ? "direct-operator" : "delegated",
                  assertDirectAdapterHandoff: options.entry === "direct" ? undefined : run.assert,
                  toolContext: run.toolContext,
                };
                const operation =
                  options.entry === "direct"
                    ? dispatchChannelMessageAction(context)
                    : tool.execute(
                        `download-${sequence}`,
                        { action: "download-file", channel: "slack", ...params },
                        source.signal,
                      );
                pending.push(operation.catch(() => undefined));
                return operation;
              };
              const invokeGateway = () => {
                const operation = (async () => {
                  const { sendHandlers } = await import("../src/gateway/server-methods/send.js");
                  const handler = sendHandlers["message.action"];
                  if (!handler) {
                    throw new Error("Missing Gateway message.action handler");
                  }
                  const responseOffset = gatewayResponses.length;
                  await handler({
                    req: {
                      type: "req",
                      id: `download-${sequence}-${responseOffset}`,
                      method: "message.action",
                    },
                    params: {
                      channel: "slack",
                      action: "download-file",
                      params: actionParams(),
                      accountId: "default",
                      sessionKey: run.options.agentSessionKey,
                      agentId: "main",
                      idempotencyKey: `gateway-download-${sequence}`,
                    },
                    respond: (ok, payload, error, meta) => {
                      gatewayResponses.push({ ok, payload, error, meta });
                    },
                    context: gatewayContext,
                    client: run.client,
                    isWebchatConnect: () => false,
                  });
                  const response = gatewayResponses[responseOffset];
                  if (!response || gatewayResponses.length !== responseOffset + 1) {
                    throw new Error("Expected one Gateway message.action response");
                  }
                  return response;
                })();
                pending.push(operation.catch(() => undefined));
                return operation;
              };
              await check({
                invoke,
                invokeGateway,
                gatewayResponses,
                gatewayCacheWrites,
                gatewayMirrorSnapshots,
                requests,
                terminalRequests,
                phases,
                mediaDir,
                preservedPath,
                displacedPath,
                body,
                token,
                binaryRequests,
                bodyStarted: bodyStarted.promise,
                assertPreserved: async () => {
                  await expect(fs.readFile(preservedPath, "utf8")).resolves.toBe(PRESERVED);
                },
              });
              await expect(fs.readFile(preservedPath, "utf8")).resolves.toBe(PRESERVED);
              expect(fixtureErrors).toEqual([]);
            },
          );
        } finally {
          heldResponse?.destroy();
          source.abort();
          await Promise.all(pending);
          interleaving.lookup = undefined;
          interleaving.afterMime = undefined;
          interleaving.afterGatewayMirror = undefined;
          __setFsSafeTestHooksForTest(undefined);
        }
      } finally {
        run.dispose();
      }
    },
  );
}

describe("registered Slack attachment downloads", () => {
  it.each([
    { name: "official installed", options: {} },
    { name: "bundled", options: { origin: "bundled" } },
    {
      name: "legacy exact-current",
      options: { legacy: true, currentOnly: true, params: { channelId: CURRENT_CHANNEL } },
    },
    { name: "direct operator", options: { entry: "direct", trusted: false } },
    { name: "GovSlack", options: { govSlack: true } },
  ] satisfies Array<{ name: string; options: FixtureOptions }>)(
    "returns the actual stored attachment through $name execution",
    async ({ options }) => {
      await withDownloadFixture(options, async (fixture) => {
        const result = await fixture.invoke();
        const saved = resultPath(result);
        expect(path.dirname(saved)).toBe(fixture.mediaDir);
        await expect(fs.readFile(saved)).resolves.toEqual(fixture.body);
        if (process.platform !== "win32") {
          expect((await fs.stat(saved)).mode & 0o777).toBe(0o644);
          expect((await fs.stat(fixture.mediaDir)).mode & 0o777).toBe(0o700);
        }
        expect(result).toMatchObject({
          details: {
            ok: true,
            fileId: FILE_ID,
            contentType: "application/pdf",
            media: { mediaUrl: saved, outbound: false },
          },
        });
        expect(
          fixture.requests.filter(({ url }) => url.pathname === "/api/files.info"),
        ).toHaveLength(1);
        expect(
          fixture.requests.find(({ url }) => url.pathname === "/api/files.info")?.body,
        ).toContain(`file=${FILE_ID}`);
        expect(fixture.binaryRequests()).toHaveLength(1);
        expect(fixture.binaryRequests()[0]?.authorization).toBe(`Bearer ${fixture.token}`);
        await fixture.assertPreserved();
      });
    },
  );

  it("uses current channel scope and read credentials while returning a bounded image", async () => {
    await withDownloadFixture(
      { currentOnly: true, userToken: true, image: true },
      async (fixture) => {
        const result = await fixture.invoke();
        const saved = resultPath(result);
        await expect(fs.readFile(saved)).resolves.toEqual(fixture.body);
        const image = result?.content.find((block) => block.type === "image");
        if (!image || image.type !== "image") {
          throw new Error("Expected Slack image output");
        }
        const bytes = Buffer.from(image.data, "base64");
        expect(await getImageMetadata(bytes)).toEqual({ width: 600, height: 300 });
        expect(bytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
        expect(result).toMatchObject({
          details: { fileId: FILE_ID, media: { mediaUrl: saved, outbound: false } },
        });
        expect(
          fixture.requests.every((request) => request.authorization === `Bearer ${fixture.token}`),
        ).toBe(true);
        await fixture.assertPreserved();
      },
    );
  });

  it.each([
    { name: "disabled channel", options: { disabled: true }, error: /not allowed/i },
    { name: "different account", options: { params: { accountId: "other" } }, error: /account/i },
    {
      name: "different origin provider",
      options: { currentProvider: "discord" },
      error: /provider and account/i,
    },
    {
      name: "unverified install",
      options: { trusted: false },
      error: /exact current conversation/i,
    },
    {
      name: "legacy cross-channel adapter",
      options: { legacy: true },
      error: /exact current conversation/i,
    },
    { name: "missing fileId", options: { params: { fileId: undefined } }, error: /fileId/i },
  ] satisfies Array<{ name: string; options: FixtureOptions; error: RegExp }>)(
    "rejects $name before provider I/O",
    async ({ options, error }) => {
      await withDownloadFixture(options, async (fixture) => {
        await expect(fixture.invoke()).rejects.toThrow(error);
        expect(fixture.requests).toEqual([]);
        expect(fixture.terminalRequests).toEqual([]);
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      });
    },
  );

  it.each([
    { name: "missing channel evidence", file: { channels: undefined }, params: {}, allowed: false },
    {
      name: "different shared channel",
      file: { channels: ["C1111111111"] },
      params: {},
      allowed: false,
    },
    {
      name: "different explicit thread",
      file: { shares: { private: { [TARGET_CHANNEL]: [{ ts: THREAD }] } } },
      params: { threadId: "1111111111.111111" },
      allowed: false,
    },
    {
      name: "matching explicit thread",
      file: { shares: { private: { [TARGET_CHANNEL]: [{ ts: THREAD }] } } },
      params: { threadId: THREAD },
      allowed: true,
    },
  ])("requires positive fresh file-share proof: $name", async ({ file, params, allowed }) => {
    await withDownloadFixture({ file, params }, async (fixture) => {
      const result = await fixture.invoke();
      expect(result).toMatchObject({ details: { ok: allowed } });
      expect(fixture.binaryRequests()).toHaveLength(allowed ? 1 : 0);
      if (!allowed) {
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      }
      await fixture.assertPreserved();
    });
  });

  it.each([
    { name: "HTTP", file: { url_private_download: "http://files.slack.com/file" } },
    {
      name: "hostname lookalike",
      file: { url_private_download: "https://files.slack.com.evil.invalid/file" },
    },
    {
      name: "commercial token to GovSlack",
      file: { url_private_download: "https://files.slack-gov.com/file" },
    },
    {
      name: "GovSlack token to commercial Slack",
      govSlack: true,
      file: { url_private_download: "https://files.slack.com/file" },
    },
    { name: "private DNS destination", dnsAddress: "10.23.45.67" },
  ] satisfies Array<FixtureOptions & { name: string }>)(
    "keeps the binary credential boundary for $name",
    async (options) => {
      await withDownloadFixture(options, async (fixture) => {
        expect(await fixture.invoke()).toMatchObject({ details: { ok: false } });
        expect(fixture.binaryRequests()).toEqual([]);
        expect(fixture.terminalRequests.filter((url) => !url.pathname.startsWith("/api/"))).toEqual(
          [],
        );
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      });
    },
  );

  it.each([
    { redirect: "https://files.slack.com/redirect", authenticated: true },
    { redirect: "https://downloads.slack-edge.com/redirect", authenticated: false },
  ])("preserves redirect credential rules for $redirect", async ({ redirect, authenticated }) => {
    await withDownloadFixture({ redirect }, async (fixture) => {
      const saved = resultPath(await fixture.invoke());
      await expect(fs.readFile(saved)).resolves.toEqual(fixture.body);
      expect(fixture.binaryRequests()).toHaveLength(2);
      expect(fixture.binaryRequests()[0]?.authorization).toBe(`Bearer ${fixture.token}`);
      expect(fixture.binaryRequests()[1]?.authorization).toBe(
        authenticated ? `Bearer ${fixture.token}` : undefined,
      );
    });
  });

  it.each(["http://files.slack.com/redirect", "https://files.slack-gov.com/redirect"])(
    "refuses the redirect destination %s before its binary request",
    async (redirect) => {
      await withDownloadFixture({ redirect }, async (fixture) => {
        expect(await fixture.invoke()).toMatchObject({ details: { ok: false } });
        expect(fixture.binaryRequests().length).toBeGreaterThan(0);
        expect(
          fixture.binaryRequests().every(({ url }) => url.href === "https://files.slack.com/file"),
        ).toBe(true);
        expect(fixture.terminalRequests.some((url) => url.href === redirect)).toBe(false);
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      });
    },
  );

  it("retains explicitly uploaded HTML files", async () => {
    await withDownloadFixture(
      {
        body: Buffer.from("<!doctype html><title>Authored document</title>"),
        contentType: "text/html",
        file: { name: "page.html" },
      },
      async (fixture) => {
        const result = await fixture.invoke();
        expect(result).toMatchObject({ details: { ok: true, contentType: "text/html" } });
        await expect(fs.readFile(resultPath(result))).resolves.toEqual(fixture.body);
      },
    );
  });

  it.each([
    {
      name: "oversized streamed content",
      options: { maxBytes: 1024 * 1024, body: Buffer.alloc(1024 * 1024 + 1) },
    },
    {
      name: "unexpected login HTML",
      options: {
        body: Buffer.from("<html>login required</html>"),
        contentType: "text/html",
        file: { mimetype: "application/pdf" },
      },
    },
  ] satisfies Array<{ name: string; options: FixtureOptions }>)(
    "leaves no artifact for $name",
    async ({ options }) => {
      await withDownloadFixture(options, async (fixture) => {
        expect(await fixture.invoke()).toMatchObject({ details: { ok: false } });
        expect(fixture.binaryRequests().length).toBeGreaterThan(0);
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
        await fixture.assertPreserved();
      });
    },
  );

  it.each([true, false])(
    "reapplies thread admission after refreshing an expired URL (allowed=%s)",
    async (allowed) => {
      await withDownloadFixture(
        {
          expired: true,
          params: { threadId: THREAD },
          file: { shares: { private: { [TARGET_CHANNEL]: [{ ts: THREAD }] } } },
          refreshedFile: {
            id: FILE_ID,
            name: "paper.pdf",
            mimetype: "application/pdf",
            channels: [TARGET_CHANNEL],
            url_private_download: "https://files.slack.com/fresh",
            shares: {
              private: { [TARGET_CHANNEL]: [{ ts: allowed ? THREAD : "1111111111.111111" }] },
            },
          },
        },
        async (fixture) => {
          const result = await fixture.invoke();
          expect(result).toMatchObject({ details: { ok: allowed } });
          expect(
            fixture.requests.filter(({ url }) => url.pathname === "/api/files.info"),
          ).toHaveLength(2);
          expect(fixture.binaryRequests()).toHaveLength(allowed ? 2 : 1);
          if (allowed) {
            await expect(fs.readFile(resultPath(result))).resolves.toEqual(fixture.body);
          } else {
            expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
          }
        },
      );
    },
  );
});

describe("Slack download authority through artifact completion", () => {
  it.each([
    { name: "fresh metadata", phase: "metadata", requests: 0 },
    { name: "bundled DNS preparation", phase: "dns", origin: "bundled", requests: 0 },
    {
      name: "redirect DNS preparation",
      phase: "redirect-dns",
      redirect: "https://downloads.slack-edge.com/redirect",
      requests: 1,
    },
    { name: "metadata refresh", phase: "refresh", expired: true, requests: 1 },
    { name: "store preparation", phase: "store-open", requests: 1 },
    { name: "body consumption", phase: "body", requests: 1 },
    { name: "MIME detection", phase: "mime", requests: 1 },
    { name: "publication preparation", phase: "prepublication", requests: 1 },
    { name: "bundled artifact publication", phase: "published", origin: "bundled", requests: 1 },
    { name: "image hydration", phase: "image-read", image: true, requests: 1 },
    {
      name: "local image result with lost run claim",
      phase: "result",
      image: true,
      revoke: "claim",
      requests: 1,
    },
  ] satisfies Array<FixtureOptions & { name: string; phase: Phase; requests: number }>)(
    "rejects revoked output and retains only preexisting files after $name",
    async (options) => {
      await withDownloadFixture(options, async (fixture) => {
        const outcome = await fixture.invoke().then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        expect(fixture.phases.has(options.phase)).toBe(true);
        expect(fixture.binaryRequests()).toHaveLength(options.requests);
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
        expect(outcome.result).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(Error);
        await fixture.assertPreserved();
      });
    },
  );

  it("propagates source cancellation while the authenticated body remains open", async () => {
    await withDownloadFixture({ phase: "body", revoke: "signal" }, async (fixture) => {
      const operation = fixture.invoke().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      await withTestTimeout(fixture.bodyStarted, 10_000, "Slack media body was not consumed");
      const outcome = await withTestTimeout(
        operation,
        2_000,
        "Slack body did not settle after source cancellation",
      );
      expect(fixture.phases.has("body")).toBe(true);
      expect(fixture.binaryRequests()).toHaveLength(1);
      expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(Error);
    });
  });

  it("preserves replacement content at a rejected result's former artifact path", async () => {
    await withDownloadFixture({ phase: "result", replaceResultFile: true }, async (fixture) => {
      await expect(fixture.invoke()).rejects.toThrow(/no longer active/i);
      const remaining = (await filesUnder(fixture.mediaDir)).filter(
        (file) => file !== fixture.preservedPath,
      );
      expect(remaining).toHaveLength(1);
      await expect(fs.readFile(remaining[0]!, "utf8")).resolves.toBe("replacement must remain");
      await expect(fs.readFile(fixture.displacedPath)).resolves.toEqual(fixture.body);
      await fixture.assertPreserved();
    });
  });
});

describe("Gateway message.action Slack download completion", () => {
  it("returns the stored attachment payload and replays the accepted response", async () => {
    await withDownloadFixture({}, async (fixture) => {
      const response = await fixture.invokeGateway();
      expect(response).toMatchObject({
        ok: true,
        payload: { ok: true, fileId: FILE_ID, contentType: "application/pdf" },
        error: undefined,
      });
      const saved = payloadPath(response.payload);
      expect(path.dirname(saved)).toBe(fixture.mediaDir);
      await expect(fs.readFile(saved)).resolves.toEqual(fixture.body);
      expect(response.payload).toMatchObject({ media: { mediaUrl: saved, outbound: false } });

      const replay = await fixture.invokeGateway();
      expect(replay).toMatchObject({ ok: true, payload: response.payload, meta: { cached: true } });
      expect(fixture.gatewayResponses).toHaveLength(2);
      expect(fixture.gatewayCacheWrites.filter((entry) => entry.ok)).toHaveLength(1);
      expect(fixture.binaryRequests()).toHaveLength(1);
      await expect(fs.readFile(saved)).resolves.toEqual(fixture.body);
    });
  });

  it("rejects a different trusted origin provider before Slack I/O", async () => {
    await withDownloadFixture({ currentProvider: "discord" }, async (fixture) => {
      const response = await fixture.invokeGateway();
      expect(response.ok).toBe(false);
      expect(response.payload).toBeUndefined();
      expect(response.error?.message).toMatch(/provider and account/i);
      expect(fixture.terminalRequests).toEqual([]);
      expect(fixture.requests).toEqual([]);
      expect(fixture.gatewayCacheWrites.some((entry) => entry.ok)).toBe(false);
      expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
    });
  });

  it.each([
    { name: "the provider result", phase: "result", revoke: "turn" },
    {
      name: "late image completion after run-claim release",
      phase: "gateway-mirror",
      revoke: "claim",
      image: true,
    },
    { name: "late completion after plugin disablement", phase: "gateway-mirror", revoke: "plugin" },
  ] satisfies Array<FixtureOptions & { name: string; phase: Phase }>)(
    "does not return or cache revoked download success at $name",
    async (options) => {
      await withDownloadFixture(options, async (fixture) => {
        const response = await fixture.invokeGateway();
        expect(fixture.phases.has(options.phase)).toBe(true);
        expect(fixture.binaryRequests()).toHaveLength(1);
        if (options.phase === "gateway-mirror") {
          expect(fixture.gatewayMirrorSnapshots).toHaveLength(1);
          expect(fixture.gatewayMirrorSnapshots[0]).toMatchObject({ responses: 0, cacheWrites: 0 });
          expect(fixture.gatewayMirrorSnapshots[0]?.artifacts).toHaveLength(1);
        }
        expect(response.ok).toBe(false);
        expect(response.payload).toBeUndefined();
        expect(response.error?.message).toMatch(/no longer active/i);
        expect(fixture.gatewayResponses).toHaveLength(1);
        expect(fixture.gatewayCacheWrites.some((entry) => entry.ok)).toBe(false);
        expect(await filesUnder(fixture.mediaDir)).toEqual([fixture.preservedPath]);
      });
    },
  );
});
