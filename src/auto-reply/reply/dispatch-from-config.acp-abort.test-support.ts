import { vi } from "vitest";
import type {
  AcpSessionResolution,
  SessionAcpMeta,
} from "../../acp/control-plane/manager.types.js";
import { resolveAcpSessionTarget } from "../../acp/control-plane/manager.utils.js";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import { acpMocks } from "./dispatch-from-config.shared.test-harness.js";

export function createDispatchConfig(diagnostics = true): OpenClawConfig {
  return {
    diagnostics: { enabled: diagnostics },
    session: { sendPolicy: { default: "allow" } },
  };
}

/** Build the ACP manager adapter used by dispatch abort boundary tests. */
export function createMockAcpSessionManager() {
  return {
    resolveSessionAsync: async (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      agentId?: string;
    }): Promise<AcpSessionResolution> => {
      const target = resolveAcpSessionTarget(params);
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        ...target,
      }) as { acp?: SessionAcpMeta } | null;
      if (entry?.acp) {
        return { kind: "ready", ...target, meta: entry.acp };
      }
      return { kind: "none", ...target };
    },
    getObservabilitySnapshot: () => ({
      runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
      turns: {
        active: 0,
        queueDepth: 0,
        completed: 0,
        failed: 0,
        averageLatencyMs: 0,
        maxLatencyMs: 0,
      },
      errorsByCode: {},
    }),
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        agentId?: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        }) as { acp?: { agent?: string; mode?: string } } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as { runtime?: AcpRuntime };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          agent: entry?.acp?.agent || "codex",
        });
        const stream = runtimeBackend.runtime.runTurn({
          handle,
          text: params.text ?? "",
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
      },
    ),
  };
}
