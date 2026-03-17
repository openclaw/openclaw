import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpGatewayStore } from "../acp/store/store.js";
import { createProjectionRestartHarness } from "../acp/test-harness/restart-harness.js";
import { createAcpTestConfig } from "../auto-reply/reply/test-fixtures/acp-runtime.js";
import { startAcpNodeProjectionRecovery } from "./server-startup.acp-node.js";

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

const zodMocks = vi.hoisted(() => {
  const createSchema = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "parse") {
            return (value: unknown) => value;
          }
          if (prop === "safeParse") {
            return (value: unknown) => ({ success: true, data: value });
          }
          if (prop === "spa") {
            return async (value: unknown) => ({ success: true, data: value });
          }
          return (..._args: unknown[]) => createSchema();
        },
      },
    );
  const z = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "coerce") {
          return new Proxy(
            {},
            {
              get:
                () =>
                (..._args: unknown[]) =>
                  createSchema(),
            },
          );
        }
        if (prop === "ZodIssueCode") {
          return {};
        }
        return (..._args: unknown[]) => createSchema();
      },
    },
  );
  return { z };
});

vi.mock("zod", () => zodMocks);

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-startup-"));
  tempRoots.push(root);
  return {
    root,
    store: new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    }),
  };
}

async function seedTerminalRun(
  store: AcpGatewayStore,
  tts?: {
    inboundAudio?: boolean;
    sessionTtsAuto?: "always" | "off" | "inbound" | "tagged";
    ttsChannel?: string;
  },
) {
  const lease = await store.acquireLease({
    sessionKey: "agent:main:acp:test-session",
    nodeId: "node-1",
    leaseId: "lease-1",
    now: 10,
  });
  await store.startRun({
    sessionKey: "agent:main:acp:test-session",
    runId: "run-1",
    requestId: "run-1",
    now: 11,
  });
  await store.recordRunDeliveryTarget({
    sessionKey: "agent:main:acp:test-session",
    runId: "run-1",
    targetId: "primary",
    channel: "telegram",
    to: "telegram:a",
    routeMode: "originating",
    ...(typeof tts?.inboundAudio === "boolean" ? { inboundAudio: tts.inboundAudio } : {}),
    ...(tts?.sessionTtsAuto ? { sessionTtsAuto: tts.sessionTtsAuto } : {}),
    ...(tts?.ttsChannel ? { ttsChannel: tts.ttsChannel } : {}),
    now: 12,
  });
  await store.appendWorkerEvent({
    nodeId: "node-1",
    sessionKey: "agent:main:acp:test-session",
    runId: "run-1",
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    seq: 1,
    event: {
      type: "text_delta",
      text: "startup replay",
      tag: "agent_message_chunk",
    },
    now: 13,
  });
  await store.resolveTerminal({
    nodeId: "node-1",
    sessionKey: "agent:main:acp:test-session",
    runId: "run-1",
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    terminalEventId: "term-1",
    finalSeq: 1,
    terminal: {
      kind: "completed",
    },
    now: 14,
  });
}

afterEach(async () => {
  routeMocks.routeReply.mockReset();
  routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
  ttsMocks.maybeApplyTtsToPayload.mockClear();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("startAcpNodeProjectionRecovery", () => {
  it("discovers terminal-persisted but unprojected runs from durable state on startup", async () => {
    const { store } = await createStore();
    await seedTerminalRun(store);

    const harness = createProjectionRestartHarness();
    const result = await startAcpNodeProjectionRecovery({
      cfg: createAcpTestConfig(),
      store,
      coordinatorFactory: harness.createCoordinatorFactory(),
    });

    expect(result.started).toContain("run-1:primary");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetKey: "run-1:primary",
          payload: expect.objectContaining({
            text: expect.stringContaining("startup replay"),
          }),
          restartMode: true,
        }),
      ]),
    );
    expect(harness.createdInstanceIds).toHaveLength(1);
  });

  it("is idempotent across repeated boots with a true disk-backed memory cut", async () => {
    const { root, store } = await createStore();
    await seedTerminalRun(store);

    const firstHarness = createProjectionRestartHarness();
    const firstResult = await startAcpNodeProjectionRecovery({
      cfg: createAcpTestConfig(),
      store,
      coordinatorFactory: firstHarness.createCoordinatorFactory(),
    });
    expect(firstResult.started).toContain("run-1:primary");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstHarness.deliveries).toHaveLength(1);

    const restartedStore = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });
    const secondHarness = createProjectionRestartHarness();
    const secondResult = await startAcpNodeProjectionRecovery({
      cfg: createAcpTestConfig(),
      store: restartedStore,
      coordinatorFactory: secondHarness.createCoordinatorFactory(),
    });

    expect(secondResult.started).toContain("run-1:primary");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondHarness.createdInstanceIds[0]).not.toBe(firstHarness.createdInstanceIds[0]);
    expect(secondHarness.deliveries).toHaveLength(0);
  });

  it("reconstructs persisted TTS delivery context for startup replay instead of silently downgrading to text-only", async () => {
    const { store } = await createStore();
    await seedTerminalRun(store, {
      sessionTtsAuto: "always",
      ttsChannel: "telegram",
    });
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        kind: string;
        payload: { text?: string };
        ttsAuto?: string;
        channel?: string;
      };
      if (params.kind === "final" && params.payload.text === "startup replay") {
        return {
          mediaUrl: "https://example.com/startup-final-tts.mp3",
          audioAsVoice: true,
        };
      }
      return params.payload;
    });

    const result = await startAcpNodeProjectionRecovery({
      cfg: createAcpTestConfig(),
      store,
    });

    expect(result.started).toContain("run-1:primary");
    await vi.waitFor(() => {
      expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
    });
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:a",
        payload: expect.objectContaining({ text: "startup replay" }),
      }),
    );
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:a",
        payload: expect.objectContaining({
          mediaUrl: "https://example.com/startup-final-tts.mp3",
          audioAsVoice: true,
        }),
      }),
    );
    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "telegram",
        ttsAuto: "always",
        inboundAudio: false,
        payload: expect.objectContaining({
          text: "startup replay",
        }),
      }),
    );
  });
});
