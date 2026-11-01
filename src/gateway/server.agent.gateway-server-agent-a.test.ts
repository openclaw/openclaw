import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.js";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import * as mediaStore from "../media/store.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import * as sessionLifecycle from "../sessions/session-controller.lifecycle.js";
import {
  observeGatewayRunExecution,
  waitForAgentCommandCall,
} from "./agent-command.test-helpers.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
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
  client: { id: "gateway-client", version: "1.0.0", platform: "test", mode: "backend" },
});

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

const modelFixture = (id: string, name: string, input: Array<"text" | "image">) => ({
  id,
  name,
  input,
});
const TEXT_ONLY_AGENT_MODEL = modelFixture("deepseek-v4-pro", "DeepSeek V4 Pro", ["text"]);
const VISION_AGENT_MODEL = modelFixture("gemma4:31b", "Gemma 4 31B", ["text", "image"]);

async function setTestSessionStore(
  entries: Record<string, Record<string, unknown>>,
  agentId?: string,
) {
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({ entries, agentId });
}
const sessionEntry = (sessionId: string) => ({ sessionId, updatedAt: Date.now() });
const sessionTarget = (sessionId: string, sessionKey: string) => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: gatewaySuite.sessionStorePath,
});
const agentRequest = (idempotencyKey: string, fields: Record<string, unknown>) =>
  rpcReq(gatewaySuite.ws, "agent", { message: "hi", idempotencyKey, ...fields });
async function acceptedAgent(idempotencyKey: string, fields: Record<string, unknown>) {
  const response = await agentRequest(idempotencyKey, fields);
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return waitForAgentCommandCall(idempotencyKey);
}
async function rejectedAgent(
  idempotencyKey: string,
  fields: Record<string, unknown>,
  error: Record<string, unknown>,
) {
  const response = await agentRequest(idempotencyKey, fields);
  expect(response).toMatchObject({ ok: false, error });
  expect(agentCommandMock).not.toHaveBeenCalled();
  return response;
}
async function setVisionModel(models = [VISION_AGENT_MODEL]) {
  testState.agentConfig = { model: { primary: "ollama-cloud/gemma4:31b" } };
  await setGatewayModelCatalogForTest(models);
}
async function setExplicitOwnership() {
  testState.agentsConfig = { ownership: "explicit", entries: { ops: {}, research: {} } };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

async function setGatewayModelCatalogForTest(
  models: ReturnType<typeof modelFixture>[],
): Promise<void> {
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await resetPreparedModelCatalogStateForTest();
  const [
    { refreshPreparedModelRuntimeSnapshots },
    { clearRuntimeConfigSnapshot, getRuntimeConfig, writeConfigFile },
  ] = await Promise.all([import("../agents/prepared-model-runtime.js"), import("../config/io.js")]);
  await writeConfigFile(
    configFor("ollama-cloud", "https://ollama-cloud.example.test/v1", {
      models: models.map((model) =>
        modelDefinition(model.id, { ...model, reasoning: false, contextWindow: 128_000 }),
      ),
    }),
  );
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

const defaultRegistry = createRegistry([]);

describe("gateway server agent", () => {
  beforeEach(() => setRegistry(defaultRegistry));

  test("agent resolves a bare key through configured fixed-store ownership", async () => {
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    await setExplicitOwnership();
    await setTestSessionStore({ global: sessionEntry("sess-ops-global") }, "ops");

    let admittedOwner: { sessionKey?: string; agentId?: string } | undefined;
    agentCommandMock.mockImplementationOnce(async () => {
      const admitted = getAgentRunContext("idem-agent-owned-global");
      admittedOwner = { sessionKey: admitted?.sessionKey, agentId: admitted?.agentId };
      return { payloads: [], meta: { durationMs: 0, terminalReply: { disposition: "empty" } } };
    });
    const call = await acceptedAgent("idem-agent-owned-global", {
      sessionKey: "global",
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(admittedOwner).toEqual({ sessionKey: "global", agentId: "ops" });
    expect(call).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      sessionId: "sess-ops-global",
      sourceReplyDeliveryMode: "message_tool_only",
    });
  });

  test("agent rejects an ownerless bare key before session preparation", async () => {
    await setExplicitOwnership();
    await rejectedAgent(
      "idem-agent-ownerless-global",
      { sessionKey: "global" },
      { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    );
  });

  test.each(["missing", "expired", "requested", "internal"] as const)(
    "agent keeps its effect-bound session identity for a %s turn",
    async (kind) => {
      const runId = `agent-bound-identity-${kind}`;
      const sessionKey = `agent:main:bound-identity-${kind}`;
      // Expired under the one-minute reset, but not old enough for archival.
      const expiredAt = Date.now() - 120_000;
      testState.sessionConfig = { reset: { mode: "idle", idleMinutes: 1 } };
      const execution = await observeGatewayRunExecution({ method: "agent", runId });
      try {
        await setTestSessionStore(
          kind === "expired"
            ? {
                [sessionKey]: {
                  sessionId: "expired-predecessor",
                  lifecycleRevision: "expired-lifecycle",
                  updatedAt: expiredAt,
                  sessionStartedAt: expiredAt,
                  lastInteractionAt: expiredAt,
                },
              }
            : {},
        );
        agentCommandMock.mockImplementationOnce(async () => ({
          payloads: [],
          meta: { durationMs: 0, terminalReply: { disposition: "empty" } },
        }));
        const command = await acceptedAgent(runId, {
          message: "keep the admitted identity",
          sessionKey,
          ...(kind === "requested" ? { sessionId: "requested-session" } : {}),
          ...(kind === "internal" ? { sessionEffects: "internal" } : {}),
        });
        await execution.waitForCompletion(runId);
        const boundSessionId = vi
          .mocked(sessionLifecycle.beginSessionEffect)
          .mock.calls.flatMap(([params]) =>
            params.sourceInput?.protocolRunId === runId && "target" in params
              ? [params.target.incarnation]
              : [],
          )[0];
        expect(boundSessionId).toEqual(expect.any(String));
        expect(boundSessionId).not.toBe("");
        expect(command.sessionId).toBe(boundSessionId);
        const stored = await loadSessionEntryAsync(sessionKey, { agentId: "main" });
        if (kind === "internal") {
          expect(stored.entry).toBeUndefined();
        } else {
          expect(stored.entry?.sessionId).toBe(boundSessionId);
        }
        if (kind === "expired") {
          expect(boundSessionId).toBe("expired-predecessor");
          expect(stored.entry?.lifecycleRevision).toEqual(expect.any(String));
          expect(stored.entry?.lifecycleRevision).not.toBe("expired-lifecycle");
        } else if (kind === "requested") {
          expect(boundSessionId).toBe("requested-session");
        }
      } finally {
        await execution.restore();
      }
    },
  );

  test("discards sessionless offloaded media without a transcript owner", async () => {
    await setVisionModel();
    vi.mocked(agentCommandMock).mockResolvedValueOnce(undefined);
    const inboundBefore = await listInboundMedia();
    const runId = "sessionless-media-success";
    const attachments = [
      { ...offloadedImageAttachment(), fileName: "large-a.png" },
      baseImageAttachment(),
      { ...offloadedImageAttachment(), fileName: "large-b.png" },
    ];
    const res = await agentRequest(runId, {
      message: "inspect media",
      groupId: "group-sessionless-media",
      groupChannel: "discord",
      attachments,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const outcome = await rpcReq(gatewaySuite.ws, "agent.wait", { runId, timeoutMs: 2_000 });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, payload: { status: "ok" } });
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
      await setVisionModel();
      await setTestSessionStore({ main: sessionEntry("aborted-media-session") });
      if (outcome === "abort") {
        vi.mocked(agentCommandMock).mockImplementationOnce((rawOpts) =>
          racePromiseWithAbortSignal(
            new Promise<void>(() => {}),
            (rawOpts as { abortSignal?: AbortSignal }).abortSignal,
            () => createAbortError("forced provider abort"),
          ),
        );
      } else {
        vi.mocked(agentCommandMock).mockImplementationOnce(async () => {});
      }
      using deleteSpy = vi.spyOn(mediaStore, "deleteMediaBuffer");
      const inboundBefore = await listInboundMedia();
      const runId = `prompt-suppressed-media-${outcome}`;
      const call = await acceptedAgent(runId, {
        message: `${outcome} after admission`,
        sessionKey: "main",
        suppressPromptPersistence: true,
        attachments: [offloadedImageAttachment()],
      });
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
        readSessionMessagesAsync(sessionTarget("aborted-media-session", String(call.sessionKey)), {
          mode: "full",
          reason: "prompt-suppressed media leak reproduction",
        }),
      ).resolves.toEqual([]);

      const mediaRef = (call.media as Array<{ url: string }>)[0]?.url;
      const mediaId = mediaRef?.split("/").at(-1);
      expect(mediaId).toBeTruthy();
      expect(
        deleteSpy.mock.calls.filter(([id, subdir]) => id === mediaId && subdir === "inbound"),
      ).toHaveLength(1);
    },
  );

  test("agent rejects unknown reply channel", async () => {
    const inboundBefore = await listInboundMedia();
    await rejectedAgent(
      "idem-agent-reply-unknown",
      { replyChannel: "unknown-channel", attachments: [offloadedImageAttachment()] },
      { message: expect.stringContaining("unknown channel") },
    );
    await expectNoNewInboundMedia(inboundBefore);
  });

  test("agent retains image offload facts beside the claim-check line", async () => {
    await setVisionModel([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);
    const inboundBefore = await listInboundMedia();
    await setTestSessionStore({ main: sessionEntry("sess-main-offloaded-media") });
    const call = await acceptedAgent("idem-agent-offloaded-media", {
      message: "what is in the image?",
      sessionKey: "main",
      attachments: [offloadedImageAttachment()],
    });

    const media = call.media as
      | Array<{ path?: string; url?: string; contentType?: string }>
      | undefined;
    expect(call.images).toEqual([]);
    expect(media).toHaveLength(1);
    expect(media?.[0]).toMatchObject({
      contentType: "image/png",
      path: expect.stringMatching(/\/media\/inbound\//),
      url: expect.stringMatching(/^media:\/\/inbound\//),
    });
    expect(call.message).toBe(`what is in the image?\n[media attached: ${media?.[0]?.url}]`);
    await expect(fs.stat(media?.[0]?.path ?? "")).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    const pending = await listSessionPendingInputs(
      sessionTarget("sess-main-offloaded-media", String(call.sessionKey)),
    );
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.message["__openclaw"]?.media).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: media?.[0]?.url })]),
    );
    const inboundAfter = await listInboundMedia();
    expect([...inboundAfter].filter((entry) => !inboundBefore.has(entry))).toHaveLength(1);
  });

  test("agent validates first image attachment against per-agent model for fresh sessions", async () => {
    testState.agentConfig = { model: { primary: "ollama-cloud/deepseek-v4-pro" } };
    testState.agentsConfig = {
      entries: {
        main: {},
        vision: { model: "ollama-cloud/gemma4:31b" },
      },
    };
    await setGatewayModelCatalogForTest([TEXT_ONLY_AGENT_MODEL, VISION_AGENT_MODEL]);

    await setTestSessionStore({ main: sessionEntry("sess-vision-fresh-image") }, "vision");
    const call = await acceptedAgent("idem-agent-vision-first-image", {
      message: "what is in the image?",
      agentId: "vision",
      sessionKey: "agent:vision:main",
      attachments: [baseImageAttachment()],
    });

    expect(call.sessionKey).toBe("agent:vision:main");
    expect(call.images).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: BASE_IMAGE_PNG }),
    ]);
  });

  test("agent errors when delivery requested and no last channel exists", async () => {
    testState.allowFrom = ["+1555"];
    await setVisionModel();
    await setTestSessionStore({ main: sessionEntry("sess-main-missing-provider") });
    const inboundBefore = await listInboundMedia();
    const res = await rejectedAgent(
      "idem-agent-missing-provider",
      {
        sessionKey: "main",
        deliver: true,
        bestEffortDeliver: false,
        attachments: [offloadedImageAttachment()],
      },
      { code: "INVALID_REQUEST", message: expect.stringContaining("Channel is required") },
    );
    expect(res.error?.message).not.toMatch(/^Error:/u);
    await expectNoNewInboundMedia(inboundBefore);
  });
});
