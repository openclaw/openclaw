import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  waitForDiagnosticEventsDrained,
  emitTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { expect, onTestFinished, test } from "vitest";
import { createDiagnosticsOtelService } from "../../extensions/diagnostics-otel/runtime-api.js";
import { withSlackIngressIdentityTestHarness } from "../../extensions/slack/ingress.test-api.js";
import { dispatchReplyFromConfig } from "../../src/auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../../src/auto-reply/reply/reply-dispatcher.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../src/config/config.js";
import { startLocalOtlpReceiver } from "./qa-lab/runtime/otel-test-support.js";

// Real Slack HTTP ingress through real dispatch, exported over real OTLP/HTTP to a
// local collector. Origin attribution happens during dispatch, so no model call is needed.

const slackConfig = (captureMessageOrigin: boolean): OpenClawConfig =>
  ({
    diagnostics: { enabled: true, otel: { enabled: true, captureMessageOrigin } },
  }) as OpenClawConfig;

// Stands in for the agent so dispatch can complete without a model request.
const replyResolver = async () => ({ text: "ok" });

async function captureInboundContext(captureMessageOrigin: boolean) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-slack-origin-"));
  try {
    let context: FinalizedMsgContext | undefined;
    await withSlackIngressIdentityTestHarness(
      {
        cfg: slackConfig(captureMessageOrigin),
        // The real channel builder preserves the native Slack conversation ID that
        // the generic test mock omits.
        runtime: createPluginRuntimeMock({
          channel: {
            inbound: { buildContext: buildChannelInboundEventContext },
          },
        }),
        stateDir,
      },
      async (harness) => {
        await harness.receiveHttp(true);
        context = harness.contexts[0];
      },
    );
    if (!context) {
      throw new Error("Slack ingress did not produce an inbound context");
    }
    return context;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function dispatchSlackTurn(captureMessageOrigin: boolean) {
  // The diagnostic producer reads the live runtime config snapshot, not the
  // dispatch params, so set it before the turn is dispatched.
  setRuntimeConfigSnapshot(slackConfig(captureMessageOrigin));
  // Let the plugin use the host's own OTLP exporter wiring for this test.
  process.env.OPENCLAW_OTEL_PRELOADED = "0";
  onTestFinished(() => {
    delete process.env.OPENCLAW_OTEL_PRELOADED;
  });
  onTestFinished(() => clearRuntimeConfigSnapshot());
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const service = createDiagnosticsOtelService();
  const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-origin-"));
  const serviceContext = {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint: `http://127.0.0.1:${port}`,
          protocol: "http/protobuf",
          traces: true,
          metrics: false,
          logs: false,
          sampleRate: 1,
          flushIntervalMs: 1000,
          captureMessageOrigin,
        },
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    // Host-owned admission capability: the exporter subscribes through this.
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEventWithPrivateData,
      onEvent: onTrustedInternalDiagnosticEvent,
      reportExporterHealth: () => {},
    },
    stateDir,
  } as Parameters<typeof service.start>[0];
  await service.start(serviceContext);
  try {
    const inbound = await captureInboundContext(captureMessageOrigin);
    await dispatchReplyFromConfig({
      ctx: inbound,
      cfg: slackConfig(captureMessageOrigin),
      dispatcher: createReplyDispatcher({ onSettled: () => {} }),
      replyResolver,
    });
    await waitForDiagnosticEventsDrained();
  } finally {
    await service.stop?.(serviceContext);
    rmSync(stateDir, { recursive: true, force: true });
  }
  const spans = receiver.capturedSpans;
  await receiver.close();
  return spans.find((span) => span.name === "openclaw.message.processed");
}

test("carries the native Slack channel from real ingress to an exported OTLP span", async () => {
  const span = await dispatchSlackTurn(true);
  expect(span?.attributes["openclaw.origin.channel.id"]).toBe("D123");
});

test("omits the native Slack channel when origin capture is off", async () => {
  const span = await dispatchSlackTurn(false);
  expect(span).toBeDefined();
  expect(span?.attributes).not.toHaveProperty("openclaw.origin.channel.id");
});
