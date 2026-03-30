/**
 * Live Aillium integration boundary adapters.
 *
 * These replace the noop defaults when an OpenClaw runtime instance is
 * connected to an Aillium Core control plane. They forward runtime
 * registration, evidence events, and contract mapping through HTTP
 * to the Aillium Core API.
 */

import type {
  AilliumIntegrationBoundary,
  ContextLifecycleEvent,
  ContextLifecycleHook,
  ContractAdapter,
  EvidenceCallbackHook,
  JsonValue,
  RuntimeRegistrationAdapter,
  RuntimeRegistrationInput,
  RuntimeRegistrationResult,
  TenantSessionMetadata,
  TenantSessionMetadataAdapter,
} from "./contracts.js";

export interface AilliumCoreConnectionConfig {
  /** Base URL for Aillium Core API (e.g. https://api.aillium.example/api) */
  baseUrl: string;
  /** Authentication token for runtime sync endpoints */
  syncToken: string;
  /** Optional timeout in milliseconds (default 15000) */
  timeoutMs?: number;
}

class LiveRuntimeRegistrationAdapter implements RuntimeRegistrationAdapter {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async register(input: RuntimeRegistrationInput): Promise<RuntimeRegistrationResult> {
    try {
      const response = await fetch(
        `${this.config.baseUrl}/master-agent/runtime/openclaw-sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-aillium-runtime-token": this.config.syncToken,
          },
          body: JSON.stringify({
            openclaw_session_key: input.runtimeId,
            metadata: {
              registration: true,
              runtimeVersion: input.runtimeVersion,
              capabilities: input.capabilities,
              ...((input.metadata as Record<string, unknown>) ?? {}),
            },
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          registered: false,
          message: `Aillium Core returned ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const result = (await response.json()) as Record<string, unknown>;
      return {
        registered: true,
        externalRuntimeRef: (result.sessionId as string) ?? undefined,
        message: "Registered with Aillium Core",
      };
    } catch (err: any) {
      return {
        registered: false,
        message: `Registration failed: ${err.message}`,
      };
    }
  }
}

class LiveContractAdapter implements ContractAdapter {
  async toExternalContract(input: JsonValue, _metadata?: TenantSessionMetadata): Promise<JsonValue> {
    // Pass-through: Aillium Core's task-bus already handles contract normalization.
    // This adapter exists for future contract versioning needs.
    return input;
  }

  async fromExternalContract(input: JsonValue, _metadata?: TenantSessionMetadata): Promise<JsonValue> {
    return input;
  }
}

class LiveEvidenceCallbackHook implements EvidenceCallbackHook {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async onEvidence(
    eventName: string,
    payload: JsonValue,
    metadata?: TenantSessionMetadata,
  ): Promise<void> {
    const sessionKey = metadata?.openclawSessionKey as string | undefined;
    if (!sessionKey) return;

    try {
      await fetch(
        `${this.config.baseUrl}/master-agent/runtime/openclaw-sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-aillium-runtime-token": this.config.syncToken,
          },
          body: JSON.stringify({
            openclaw_session_key: sessionKey,
            artifacts: [
              {
                uri: `evidence://${eventName}/${Date.now()}`,
                kind: eventName,
                metadata: {
                  ...(typeof payload === "object" && payload !== null && !Array.isArray(payload)
                    ? (payload as Record<string, unknown>)
                    : { value: payload }),
                  evidenceEmittedAt: new Date().toISOString(),
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        },
      );
    } catch {
      // Best-effort evidence delivery; do not block runtime execution
    }
  }
}

class LiveTenantSessionMetadataAdapter implements TenantSessionMetadataAdapter {
  async project(metadata: TenantSessionMetadata): Promise<TenantSessionMetadata> {
    // Preserve all metadata — Aillium Core uses tenantId from its own session lookup,
    // not from OpenClaw metadata, so no stripping needed.
    return metadata;
  }
}

class LiveContextLifecycleHook implements ContextLifecycleHook {
  constructor(private readonly config: AilliumCoreConnectionConfig) {}

  async onContextLifecycle(event: ContextLifecycleEvent): Promise<void> {
    try {
      await fetch(
        `${this.config.baseUrl}/master-agent/runtime/context-lifecycle`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-aillium-runtime-token": this.config.syncToken,
          },
          body: JSON.stringify({
            openclaw_session_key: event.sessionKey,
            openclaw_session_id: event.sessionId,
            event_kind: event.kind,
            payload: event.payload,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        },
      );
    } catch {
      // Best-effort lifecycle delivery; do not block runtime execution
    }
  }
}

export function createLiveAilliumBoundary(
  config: AilliumCoreConnectionConfig,
): AilliumIntegrationBoundary {
  return {
    runtimeRegistration: new LiveRuntimeRegistrationAdapter(config),
    contractAdapter: new LiveContractAdapter(),
    evidenceHooks: [new LiveEvidenceCallbackHook(config)],
    tenantSessionMetadata: new LiveTenantSessionMetadataAdapter(),
    contextLifecycle: new LiveContextLifecycleHook(config),
  };
}
