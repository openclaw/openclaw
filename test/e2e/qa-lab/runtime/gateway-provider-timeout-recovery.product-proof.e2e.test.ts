import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { startOpenAiResponsesModelServer } from "../../../helpers/openai-responses-model-fixture.js";
import { createDeferred } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  messageText,
  sendChat,
  waitForRun,
  writeFixtureReply,
  type GatewayChatHistory,
} from "./gateway-recovery.test-support.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const RESPONSE_MARKER = "PROVIDER_TIMEOUT_RECOVERY_PROOF_OK";
const GLOBAL_RECOVERY_FLOOR_MS = 360_000;
const CHECKPOINT_AFTER_FLOOR_MS = GLOBAL_RECOVERY_FLOOR_MS + 45_000;
const PROVIDER_ALLOWANCE_MS = 450_000;
const TEST_TIMEOUT_MS = PROVIDER_ALLOWANCE_MS + 60_000;

type StabilityEvent = Partial<Record<"type" | "action" | "ageMs" | "reason", unknown>>;

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type ProviderProof = {
  requestStartedAt?: number;
  clientClosedAt?: number;
  responseReleasedAt?: number;
};

function writeProgress(phase: string): void {
  // E2E runs suppress console output. The worker fd reaches the runner's silence watchdog.
  writeSync(2, `${JSON.stringify({ phase })}\n`);
}

async function startControlledProvider() {
  const responseGate = createDeferred();
  const proof: ProviderProof = {};
  const server = await startOpenAiResponsesModelServer({
    modelId: "gpt-5.6-luna",
    bindError: "controlled provider did not bind a loopback port",
    onRequest: async (request, response) => {
      for await (const chunk of request) {
        // Consume the real provider request before holding its response open.
        void chunk;
      }
      proof.requestStartedAt = Date.now();
      response.once("close", () => {
        if (proof.responseReleasedAt === undefined) {
          proof.clientClosedAt = Date.now();
        }
      });
      await responseGate.promise;
      proof.responseReleasedAt = Date.now();
      writeFixtureReply(
        response,
        RESPONSE_MARKER,
        "provider-timeout-recovery-proof-message",
        "provider-timeout-recovery-proof-response",
      );
    },
  });
  return {
    baseUrl: server.baseUrl,
    proof,
    release: () => responseGate.resolve(),
    stop: async () => {
      responseGate.resolve();
      await server.close();
    },
  };
}

describe.runIf(process.env.OPENCLAW_PROVIDER_TIMEOUT_RECOVERY_PROOF === "1")(
  "Gateway provider-timeout recovery product proof",
  () => {
    let provider: Awaited<ReturnType<typeof startControlledProvider>>;
    let gateway: QaGatewayChild;
    const cleanups: Array<() => Promise<void>> = [];
    const stability = (sinceSeq?: number) =>
      gateway.call(
        "diagnostics.stability",
        { limit: 1000, ...(sinceSeq === undefined ? {} : { sinceSeq }) },
        { timeoutMs: 10_000 },
      ) as Promise<StabilitySnapshot>;

    afterAll(async () => {
      writeProgress("fixture-cleanup-started");
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      writeProgress("fixture-cleanup-complete");
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "provider-timeout recovery proof cleanup failed");
      }
    });

    // Vitest gives fixture hooks their own bounded budget; the unchanged test
    // deadline starts only after Gateway bootstrap has completed.
    beforeAll(async () => {
      writeProgress("fixture-bootstrap-started");
      provider = await startControlledProvider();
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        initializeCurrentRuntimeState: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--import", "tsx", "src/entry.ts"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: (config) => {
          const providerConfig = config.models?.providers?.["mock-openai"];
          if (!providerConfig) {
            throw new Error("mock-openai provider is missing from QA gateway config");
          }
          providerConfig.timeoutSeconds = PROVIDER_ALLOWANCE_MS / 1_000;
          config.plugins = { enabled: false };
          config.diagnostics = { enabled: true };
          const defaults = ((config.agents ??= {}).defaults ??= {});
          defaults.timeoutSeconds = TEST_TIMEOUT_MS / 1_000;
          return config;
        },
      });

      writeProgress("fixture-bootstrap-complete");
    });

    it(
      "keeps a quiet provider request alive past recovery and completes within its allowance",
      { timeout: TEST_TIMEOUT_MS },
      async ({ signal }) => {
        const baseline = await stability();
        const baselineSeq = typeof baseline.lastSeq === "number" ? baseline.lastSeq : 0;
        const sessionKey = `agent:qa:provider-timeout-recovery-${randomUUID()}`;
        const started = await sendChat(
          gateway,
          sessionKey,
          "Hold this provider request open, then reply with the proof marker.",
        );
        expect(started).toMatchObject({ status: "started" });
        expect(typeof started.runId).toBe("string");

        let nextAdmissionProgressAt = Date.now();
        while (provider.proof.requestStartedAt === undefined) {
          if (Date.now() >= nextAdmissionProgressAt) {
            writeProgress("provider-request-pending");
            nextAdmissionProgressAt = Date.now() + 60_000;
          }
          await sleep(100, undefined, { signal });
        }
        while (Date.now() - provider.proof.requestStartedAt < CHECKPOINT_AFTER_FLOOR_MS) {
          const elapsedMs = Date.now() - provider.proof.requestStartedAt;
          writeProgress("provider-request-active");
          await sleep(Math.min(60_000, CHECKPOINT_AFTER_FLOOR_MS - elapsedMs), undefined, {
            signal,
          });
        }

        const checkpointElapsedMs = Date.now() - provider.proof.requestStartedAt;
        const checkpoint = await stability(baselineSeq);
        const recoveryEvents = (checkpoint.events ?? []).filter(
          (event) =>
            event.type === "session.recovery.requested" ||
            event.type === "session.recovery.completed",
        );
        expect(checkpointElapsedMs).toBeGreaterThanOrEqual(CHECKPOINT_AFTER_FLOOR_MS);
        expect(checkpointElapsedMs).toBeLessThan(PROVIDER_ALLOWANCE_MS);
        expect(provider.proof.clientClosedAt).toBeUndefined();
        expect(recoveryEvents).toEqual([]);

        writeProgress("provider-checkpoint-complete");
        provider.release();
        const terminal = await waitForRun(gateway, started.runId);
        expect(terminal.status).toBe("ok");
        const history = (await gateway.call(
          "chat.history",
          { sessionKey, limit: 20 },
          { timeoutMs: 10_000 },
        )) as GatewayChatHistory;
        expect(
          (history.messages ?? []).some(
            (message) => message.role === "assistant" && messageText(message) === RESPONSE_MARKER,
          ),
        ).toBe(true);

        writeProgress("provider-timeout-recovery-proof-complete");
      },
    );
  },
);
