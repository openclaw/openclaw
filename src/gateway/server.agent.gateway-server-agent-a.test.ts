/**
 * Gateway server-agent integration tests for agent startup and session dispatch.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.js";
import { createAbortError } from "../infra/abort-signal.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { redactSensitiveText } from "../logging/redact.js";
import * as mediaStore from "../media/store.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { waitForAgentCommandCall } from "./agent-command.test-helpers.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-session-", {
  client: {
    id: "gateway-client",
    version: "1.0.0",
    platform: "test",
    mode: "backend",
  },
});

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

type GatewayModelFixture = {
  id: string;
  name: string;
  provider: string;
  input: Array<"text" | "image">;
};

const TEXT_ONLY_AGENT_MODEL: GatewayModelFixture = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "ollama-cloud",
  input: ["text"],
};

const VISION_AGENT_MODEL: GatewayModelFixture = {
  id: "gemma4:31b",
  name: "Gemma 4 31B",
  provider: "ollama-cloud",
  input: ["text", "image"],
};

async function setTestSessionStore(params: {
  entries: Record<string, Record<string, unknown>>;
  agentId?: string;
}) {
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({
    entries: params.entries,
    agentId: params.agentId,
  });
}

async function setGatewayModelCatalogForTest(models: GatewayModelFixture[]): Promise<void> {
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await resetPreparedModelCatalogStateForTest();
  const [
    { refreshPreparedModelRuntimeSnapshots },
    { clearRuntimeConfigSnapshot, getRuntimeConfig, writeConfigFile },
  ] = await Promise.all([import("../agents/prepared-model-runtime.js"), import("../config/io.js")]);
  await writeConfigFile({
    models: {
      providers: Object.fromEntries(
        [...new Set(models.map((model) => model.provider))].map((provider) => [
          provider,
          {
            baseUrl: `https://${provider}.example.test/v1`,
            models: models
              .filter((model) => model.provider === provider)
              .map((model) => ({
                id: model.id,
                name: model.name,
                input: model.input,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              })),
          },
        ]),
      ),
    },
  });
  clearRuntimeConfigSnapshot();
  await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), { gatewayLifecycle: true });
}

const baseImageAttachment = () => ({
  mimeType: "image/png",
  fileName: "tiny.png",
  content: BASE_IMAGE_PNG,
});

const offloadedImageAttachment = () => ({
  ...baseImageAttachment(),
  fileName: "large.png",
  content: Buffer.concat([Buffer.from(BASE_IMAGE_PNG, "base64"), Buffer.alloc(2_000_001)]).toString(
    "base64",
  ),
});

async function listInboundMedia(): Promise<Set<string>> {
  const entries = await fs.readdir(path.join(mediaStore.getMediaDir(), "inbound")).catch(() => []);
  return new Set(entries);
}

async function expectNoNewInboundMedia(before: Set<string>): Promise<void> {
  await vi.waitFor(async () => {
    const after = await listInboundMedia();
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);
  });
}

async function runAgentImageRequest(params: {
  idempotencyKey: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  attachment?: ReturnType<typeof baseImageAttachment>;
  failureMessage: string;
}) {
  await setTestSessionStore({
    agentId: params.agentId,
    entries: {
      main: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    },
  });

  const res = await rpcReq(gatewaySuite.ws, "agent", {
    message: "what is in the image?",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey ?? "main",
    attachments: [params.attachment ?? baseImageAttachment()],
    idempotencyKey: params.idempotencyKey,
  });
  expect(res.ok, `${params.failureMessage}: ${JSON.stringify(res)}`).toBe(true);

  return await waitForAgentCommandCall(params.idempotencyKey);
}

function expectBaseImageForwarded(images: unknown) {
  const forwarded = images as Array<Record<string, unknown>> | undefined;
  expect(forwarded, "agent command should include one forwarded image attachment").toHaveLength(1);
  expect(forwarded?.[0]?.type).toBe("image");
  expect(forwarded?.[0]?.mimeType).toBe("image/png");
  expect(forwarded?.[0]?.data).toBe(BASE_IMAGE_PNG);
}

const defaultRegistry = createRegistry([]);

describe("gateway server agent", () => {
  beforeEach(() => {
    vi.mocked(agentCommandMock).mockClear();
    testState.agentsConfig = undefined;
    testState.allowFrom = undefined;
    setRegistry(defaultRegistry);
  });

  afterEach(() => {
    testState.agentsConfig = undefined;
    testState.allowFrom = undefined;
  });

  test("agent resolves a bare key through configured fixed-store ownership", async () => {
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js");
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await setTestSessionStore({
      agentId: "ops",
      entries: {
        global: {
          sessionId: "sess-ops-global",
          updatedAt: Date.now(),
        },
      },
    });

    let admittedOwner: { sessionKey?: string; agentId?: string } | undefined;
    agentCommandMock.mockImplementationOnce(async () => {
      const admitted = getAgentRunContext("idem-agent-owned-global");
      admittedOwner = { sessionKey: admitted?.sessionKey, agentId: admitted?.agentId };
      return { payloads: [], meta: { durationMs: 0 } };
    });
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "global",
      sourceReplyDeliveryMode: "message_tool_only",
      idempotencyKey: "idem-agent-owned-global",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const call = await waitForAgentCommandCall("idem-agent-owned-global");
    expect(admittedOwner).toEqual({ sessionKey: "global", agentId: "ops" });
    expect(call.agentId).toBe("ops");
    expect(call.sessionKey).toBe("global");
    expect(call.sessionId).toBe("sess-ops-global");
    expect(call.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  test("agent rejects an ownerless bare key before session preparation", async () => {
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js");
    clearRuntimeConfigSnapshot();
    clearConfigCache();

    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      sessionKey: "global",
      idempotencyKey: "idem-agent-ownerless-global",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
    expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
  });

  test("discards sessionless offloaded media without a transcript owner", async () => {
    vi.mocked(agentCommandMock).mockResolvedValueOnce(undefined);
    const inboundBefore = await listInboundMedia();
    const runId = "sessionless-media-success";
    const attachments = [
      { ...offloadedImageAttachment(), fileName: "large-a.png" },
      baseImageAttachment(),
      { ...offloadedImageAttachment(), fileName: "large-b.png" },
    ];
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "inspect media",
      groupId: "group-sessionless-media",
      groupChannel: "discord",
      attachments,
      idempotencyKey: runId,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const call = await waitForAgentCommandCall(runId);
    expect(call.sessionKey).toBeUndefined();
    expect(call.media).toHaveLength(2);
    expect(call.images).toHaveLength(1);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    await expectNoNewInboundMedia(inboundBefore);
  });

  test.each(["completion", "abort"] as const)(
    "prompt-suppressed %s discards each managed offload once without a transcript row",
    async (outcome) => {
      testState.agentConfig = { model: { primary: "ollama-cloud/gemma4:31b" } };
      await setGatewayModelCatalogForTest([VISION_AGENT_MODEL]);
      await setTestSessionStore({
        entries: { main: { sessionId: "aborted-media-session", updatedAt: Date.now() } },
      });
      if (outcome === "abort") {
        vi.mocked(agentCommandMock).mockImplementationOnce(
          async (rawOpts) =>
            await new Promise<void>((_resolve, reject) => {
              (rawOpts as { abortSignal?: AbortSignal }).abortSignal?.addEventListener(
                "abort",
                () => reject(createAbortError("forced provider abort")),
                { once: true },
              );
            }),
        );
      } else {
        vi.mocked(agentCommandMock).mockImplementationOnce(async () => {});
      }
      const deleteSpy = vi.spyOn(mediaStore, "deleteMediaBuffer");
      const inboundBefore = await listInboundMedia();
      const runId = `prompt-suppressed-media-${outcome}`;
      try {
        const res = await rpcReq(gatewaySuite.ws, "agent", {
          message: `${outcome} after admission`,
          sessionKey: "main",
          suppressPromptPersistence: true,
          attachments: [offloadedImageAttachment()],
          idempotencyKey: runId,
        });
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const call = await waitForAgentCommandCall(runId);
        if (outcome === "abort") {
          const abortRes = await rpcReq(gatewaySuite.ws, "chat.abort", {
            sessionKey: call.sessionKey,
            runId,
          });
          expect(abortRes.ok, JSON.stringify(abortRes)).toBe(true);
        }
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        await expectNoNewInboundMedia(inboundBefore);
        await expect(
          readSessionMessagesAsync(
            {
              agentId: "main",
              sessionId: "aborted-media-session",
              sessionKey: String(call.sessionKey),
              storePath: gatewaySuite.sessionStorePath,
            },
            { mode: "full", reason: "prompt-suppressed media leak reproduction" },
          ),
        ).resolves.toEqual([]);

        const mediaRef = (call.media as Array<{ url: string }>)[0]?.url;
        const mediaId = mediaRef?.split("/").at(-1);
        expect(mediaId).toBeTruthy();
        expect(
          deleteSpy.mock.calls.filter(([id, subdir]) => id === mediaId && subdir === "inbound"),
        ).toHaveLength(1);
      } finally {
        deleteSpy.mockRestore();
      }
    },
  );

  test("agent rejects unknown reply channel", async () => {
    const inboundBefore = await listInboundMedia();
    const res = await rpcReq(gatewaySuite.ws, "agent", {
      message: "hi",
      replyChannel: "unknown-channel",
      attachments: [offloadedImageAttachment()],
      idempotencyKey: "idem-agent-reply-unknown",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("unknown channel");
    await expectNoNewInboundMedia(inboundBefore);

    const spy = vi.mocked(agentCommandMock);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent retains image offload facts beside the claim-check line", async () => {
    testState.agentConfig = { model: { primary: "ollama-cloud/gemma4:31b" } };
    await setGatewayModelCatalogForTest([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);
    const inboundBefore = await listInboundMedia();
    const call = await runAgentImageRequest({
      idempotencyKey: "idem-agent-offloaded-media",
      sessionId: "sess-main-offloaded-media",
      attachment: offloadedImageAttachment(),
      failureMessage: "agent RPC failed before forwarding offloaded media facts",
    });

    const media = call.media as
      | Array<{ path?: string; url?: string; contentType?: string }>
      | undefined;
    expect(call.images).toEqual([]);
    expect(media).toHaveLength(1);
    expect(media?.[0]).toMatchObject({ contentType: "image/png" });
    expect(media?.[0]?.path).toMatch(/\/media\/inbound\//);
    expect(media?.[0]?.url).toMatch(/^media:\/\/inbound\//);
    expect(call.message).toBe(`what is in the image?\n[media attached: ${media?.[0]?.url}]`);
    await expect(fs.stat(media?.[0]?.path ?? "")).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    const pending = await listSessionPendingInputs({
      agentId: "main",
      sessionId: "sess-main-offloaded-media",
      sessionKey: String(call.sessionKey),
      storePath: gatewaySuite.sessionStorePath,
    });
    expect(pending.items).toHaveLength(1);
    // Inbound ids are random; compare the durable fact against its public
    // redaction contract because an id can resemble sensitive text.
    const transcriptMediaUrl = media?.[0]?.url ? redactSensitiveText(media[0].url) : undefined;
    expect(pending.items[0]?.message["__openclaw"]?.media).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: transcriptMediaUrl })]),
    );
    const inboundAfter = await listInboundMedia();
    expect([...inboundAfter].filter((entry) => !inboundBefore.has(entry))).toHaveLength(1);
  });

  test("agent validates first image attachment against per-agent model for fresh sessions", async () => {
    testState.agentConfig = { model: { primary: "ollama-cloud/deepseek-v4-flash" } };
    testState.agentsConfig = {
      entries: {
        main: {},
        vision: { model: "ollama-cloud/gemma4:31b" },
      },
    };
    await setGatewayModelCatalogForTest([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);

    const call = await runAgentImageRequest({
      agentId: "vision",
      sessionKey: "agent:vision:main",
      idempotencyKey: "idem-agent-vision-first-image",
      sessionId: "sess-vision-fresh-image",
      failureMessage: "agent RPC should accept image using per-agent vision model",
    });

    expect(call.sessionKey).toBe("agent:vision:main");
    expectBaseImageForwarded(call.images);
  });

  test("agent errors when delivery requested and no last channel exists", async () => {
    testState.allowFrom = ["+1555"];
    try {
      testState.agentConfig = { model: { primary: "ollama-cloud/gemma4:31b" } };
      await setGatewayModelCatalogForTest([VISION_AGENT_MODEL]);
      await setTestSessionStore({
        entries: {
          main: {
            sessionId: "sess-main-missing-provider",
            updatedAt: Date.now(),
          },
        },
      });
      const inboundBefore = await listInboundMedia();
      const res = await rpcReq(gatewaySuite.ws, "agent", {
        message: "hi",
        sessionKey: "main",
        deliver: true,
        bestEffortDeliver: false,
        attachments: [offloadedImageAttachment()],
        idempotencyKey: "idem-agent-missing-provider",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_REQUEST");
      expect(res.error?.message).toContain("Channel is required");
      expect(res.error?.message).not.toMatch(/^Error:/u);
      expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
      await expectNoNewInboundMedia(inboundBefore);
    } finally {
      testState.allowFrom = undefined;
    }
  });
});
