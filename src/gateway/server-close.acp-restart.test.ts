/** An in-process Gateway restart must hand ACP work to a live session manager. */
import { randomUUID } from "node:crypto";
import type { AcpRuntime, AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

const backendId = "restart-proof";

function createPromptRecordingRuntime() {
  const prompts: string[] = [];
  const runtime: AcpRuntime = {
    ownerAwareSessions: 1,
    ensureSession: vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      backend: backendId,
      runtimeSessionName: input.sessionKey,
    })),
    async *runTurn(input) {
      prompts.push(input.text);
      yield { type: "done" as const };
    },
    async cancel() {},
    close: vi.fn<AcpRuntime["close"]>(async () => {}),
  };
  return { runtime, prompts };
}

async function runPrompt(cfg: OpenClawConfig, sessionKey: string, text: string) {
  const events: AcpRuntimeEvent[] = [];
  const requestId = randomUUID();
  await getAcpSessionManager().runTurn({
    cfg,
    sessionKey,
    provenance: "system",
    text,
    mode: "prompt",
    requestId,
    admittedRunContext: createTestAdmittedRunContext(requestId),
    onEvent: (event) => {
      events.push(event);
    },
  });
  return events;
}

it("submits ACP prompts after the Gateway closes and restarts in the same process", async () => {
  const fixture = await createGatewayMetadataCloseFixture("acp-in-process-restart");
  const { runtime, prompts } = createPromptRecordingRuntime();
  const cfg: OpenClawConfig = {
    ...fixture.config,
    acp: { enabled: true, backend: backendId, dispatch: { enabled: true } },
  };
  const sessionKey = `agent:codex:acp:${randomUUID()}`;
  const cancelled = { type: "done", status: "cancelled", stopReason: "cancel" };
  try {
    // The restarted Gateway keeps this module graph; only the listener is new.
    const firstPort = await fixture.reservePort();
    const restartPort = await fixture.reservePort();
    const first = await fixture.start(firstPort);
    registerAcpRuntimeBackend({ id: backendId, runtime });
    const beforeRestart = getAcpSessionManager();
    await beforeRestart.initializeSession({ cfg, sessionKey, agent: "codex", mode: "persistent" });
    expect(await runPrompt(cfg, sessionKey, "before restart")).not.toContainEqual(cancelled);

    await first.close({ reason: "gateway restarting", restartExpectedMs: 1_000 });
    expect(beforeRestart.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
    await fixture.start(restartPort);
    // Plugins register their ACP backend again on every Gateway boot.
    registerAcpRuntimeBackend({ id: backendId, runtime });

    const events = await runPrompt(cfg, sessionKey, "after restart");
    expect(events).not.toContainEqual(cancelled);
    expect(prompts).toEqual(["before restart", "after restart"]);
    expect(getAcpSessionManager()).not.toBe(beforeRestart);
  } finally {
    unregisterAcpRuntimeBackend(backendId);
    await fixture.cleanup();
  }
});
