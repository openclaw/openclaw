import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { getMediaDir } from "../media/store.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import {
  createChatVisionModelCatalogSnapshot,
  createDirectChatContext,
} from "./server-chat.agent-events.test-helpers.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { callDirectChat } from "./server.chat-direct-handler.test-support.js";
import {
  captureChatResponse,
  type CapturedChatResponse,
} from "./server.chat-response.test-support.js";
import {
  createDirectChatSessionStoreFixture,
  writeStoredMainSession,
} from "./server.chat-session-store.test-support.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import {
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const directories = createTempDirTracker();
const sessionStoreFixture = createDirectChatSessionStoreFixture(directories);
const openDirectChatSession = sessionStoreFixture.open;
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  sessionStoreFixture.prepare();
});
beforeEach(async () => {
  openDirectChatSession({ fresh: true });
  await writeStoredMainSession({ modelProvider: "test-provider", model: "vision-model" });
});
afterEach(async () => {
  await resetDirectChatSession();
  directories.cleanup();
});
afterAll(async () => {
  try {
    await sessionStoreFixture.dispose();
  } finally {
    await harness.close();
  }
});

function getDirectChatSessionWorkRelease() {
  const sessionKey = "agent:main:main";
  return captureSessionControllerSettlement({
    scope: resolveSessionStorePathForScope({ sessionKey }, getRuntimeConfig()),
    identities: [sessionKey],
  });
}

async function resetDirectChatSession() {
  await disposeSessionReadContexts();
  await sessionStoreFixture.reset();
  dispatchInboundMessageMock.mockReset();
  resetConfigRuntimeState();
}

test("chat.send keeps duplicate attachment sends retryable until input is admitted", async ({
  signal,
}) => {
  const [dispatchEntered, dispatchRelease] = [createDeferred(), createDeferred()];
  const catalogEntered = createDeferred();
  let first: Promise<void> | undefined;
  const firstCatalogSnapshot =
    createDeferred<ReturnType<typeof createChatVisionModelCatalogSnapshot>>();
  try {
    const responses: Array<CapturedChatResponse & { id: string }> = [];
    const context = createDirectChatContext({
      loadGatewayModelCatalogSnapshot: vi
        .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
        .mockImplementationOnce(() => {
          catalogEntered.resolve();
          return firstCatalogSnapshot.promise;
        })
        .mockResolvedValue(createChatVisionModelCatalogSnapshot()),
    });
    dispatchInboundMessageMock.mockImplementation(async () => {
      dispatchEntered.resolve();
      await dispatchRelease.promise;
    });

    const params = {
      sessionKey: "main",
      message: "see image",
      idempotencyKey: "idem-attachment-race",
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        },
      ],
    };
    const callSend = (id: string) =>
      callDirectChat("chat.send", {
        id,
        params,
        respond: (ok, payload, error) => {
          responses.push({ id, ok, payload, error });
        },
        context,
      });

    const duplicateResponse = {
      id: "duplicate",
      ok: false,
      payload: undefined,
      error: {
        code: "UNAVAILABLE",
        message: "Chat input is being admitted; retry the same request.",
        retryable: true,
      },
    };
    first = Promise.resolve(callSend("first"));
    void first.catch(() => {});
    await withinTest(
      awaitGateBeforeSettlement(
        catalogEntered.promise,
        first,
        "chat.send settled before preparing its attachment",
      ),
      signal,
    );

    await withinTest(callSend("duplicate"), signal);
    expect(responses).toEqual([duplicateResponse]);

    firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
    await withinTest(first, signal);

    expect(responses).toEqual([
      duplicateResponse,
      {
        id: "first",
        ok: true,
        payload: { runId: "idem-attachment-race", status: "started" },
        error: undefined,
      },
    ]);
    await withinTest(dispatchEntered.promise, signal);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    dispatchRelease.resolve();
    await getDirectChatSessionWorkRelease();
  } finally {
    firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
    dispatchRelease.resolve();
    await Promise.allSettled(first ? [first] : []);
    await getDirectChatSessionWorkRelease();
  }
});

test("chat.send discards prepared inbound media when a hook blocks the turn", async ({
  signal,
}) => {
  const attachments = await import("./chat-attachments.js");
  const discard = attachments.discardPreparedInboundMedia;
  const discarded = createDeferred();
  const cleanup = vi
    .spyOn(attachments, "discardPreparedInboundMedia")
    .mockImplementation((...args) => {
      const pending = discard(...args);
      if (args[0].length > 0) {
        discarded.resolve(pending);
      }
      return pending;
    });
  try {
    const context = createDirectChatContext();
    const inboundDir = path.join(getMediaDir(), "inbound");
    const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
    // A before_agent_run block persists only the redacted reason — no media
    // markers — so dispatch must discard the prepared refs on settle.
    dispatchInboundMessageMock.mockImplementationOnce(async ({ replyOptions }) => {
      replyOptions?.userTurnTranscriptRecorder?.markBlocked();
    });
    const responses: CapturedChatResponse[] = [];
    await callDirectChat("chat.send", {
      id: "blocked-turn-media",
      params: {
        sessionKey: "main",
        message: "blocked turn with media",
        idempotencyKey: "idem-blocked-turn-media",
        attachments: [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "notes.txt",
            content: Buffer.from("offloaded inbound media").toString("base64"),
          },
        ],
      },
      client: {
        connId: "conn-owner",
        connect: {
          ...gatewayConnect(["operator.write"], { version: "1.0.0", platform: "web" }),
          device: {
            id: "dev-owner",
            publicKey: "synthetic-public-key",
            signature: "synthetic-signature",
            signedAt: 0,
            nonce: "synthetic-nonce",
          },
        },
      },
      respond: captureChatResponse(responses),
      context,
    });
    expect(responses[0]?.ok, JSON.stringify(responses[0])).toBe(true);
    await withinTest(discarded.promise, signal);
    const remaining = await fs.readdir(inboundDir).catch(() => []);
    expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([]);
  } finally {
    cleanup.mockRestore();
  }
});
