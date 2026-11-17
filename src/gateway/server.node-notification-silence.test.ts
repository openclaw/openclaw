import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { installCronRepairTurn } from "./server.cron-repair-turn.test-support.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));

installGatewayTestHooks({ scope: "suite" });

describeWithGatewayServer("gateway phone notifications", (getStarted) => {
  test("an authored NO_REPLY to a notification settles silently on the CLI", async ({ signal }) => {
    const caseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-notification-silence-"));
    const sessionKey = "agent:main:dashboard:phone-notifications";
    testState.sessionStorePath = path.join(caseDir, "sessions.json");
    await writeSessionStore({
      agentId: "main",
      entries: {
        [sessionKey]: { sessionId: "notifications", updatedAt: Date.now(), lastChannel: "webchat" },
      },
    });
    const { runPreparedCliAgent } = await import("../agents/cli-runner.js");
    const execution = await import("../agents/cli-runner/execute.runtime.js");
    // Replace external CLI I/O only: admission, reply policy and CLI completion stay real.
    const cliOutput = vi.spyOn(execution, "executePreparedCliRun");
    cliOutput.mockResolvedValue({ text: "NO_REPLY", rawText: "NO_REPLY" });
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const outcome = createDeferred<{ result?: EmbeddedAgentRunResult; error?: unknown }>();
    const turn = installCronRepairTurn(async (params) => {
      const context = buildPreparedCliRunContext({
        workspaceDir: caseDir,
        sessionKey: params.sessionKey,
        runId: params.runId,
        backend: { sessionMode: "none" },
      });
      const { prompt, inputProvenance, terminalReplyExpectation } = params;
      context.params = { ...context.params, prompt, inputProvenance, terminalReplyExpectation };
      const settled: { result?: EmbeddedAgentRunResult; error?: unknown } =
        await runPreparedCliAgent(context).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      outcome.resolve(settled);
      if (!settled.result) {
        throw settled.error;
      }
      return "NO_REPLY";
    });

    const paired = await pairDeviceIdentity({
      name: "notification-silence-phone",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const pairing = await requestNodePairing({
      nodeId: paired.identity.deviceId,
      platform: "android",
      deviceFamily: "Android",
      commands: [],
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
    });
    const phone = await connectGatewayClient({
      url: `ws://127.0.0.1:${getStarted().port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "notification silence phone",
      clientVersion: "1.0.0",
      platform: "android",
      deviceFamily: "Android",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
      deviceIdentity: paired.identity,
    });
    try {
      await phone.request("node.event", {
        event: "notifications.changed",
        payload: {
          change: "posted",
          key: "promo-1",
          sessionKey,
          packageName: "com.example.shop",
          title: "Weekend sale",
          text: "20% off everything",
        },
      });

      // On 2026.11.5 this failed as empty_response, which sent the turn to the fallback model.
      const settled = await withinTest(outcome.promise, signal);
      expect(settled.error).toBeUndefined();
      expect(settled.result?.meta.terminalReply).toMatchObject({ disposition: "silent" });
      expect(turn.context()).toMatchObject({
        SessionKey: sessionKey,
        InputProvenance: { kind: "internal_system" },
      });
      expect(cliOutput).toHaveBeenCalledOnce();
    } finally {
      await phone.stopAndWait();
      cliOutput.mockRestore();
      await fs.rm(caseDir, { recursive: true, force: true });
    }
  });
});
