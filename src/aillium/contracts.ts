/**
 * Thin adapter contracts for Aillium integration points.
 *
 * Keep OpenClaw runtime/orchestration behavior upstream-aligned and inject
 * enterprise control-plane concerns from Aillium Core via these boundaries.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TenantSessionMetadata = Readonly<Record<string, JsonValue>>;

export interface RuntimeRegistrationInput {
  runtimeId: string;
  runtimeVersion: string;
  capabilities: readonly string[];
  metadata?: TenantSessionMetadata;
}

export interface RuntimeRegistrationResult {
  registered: boolean;
  externalRuntimeRef?: string;
  message?: string;
}

export interface RuntimeRegistrationAdapter {
  /**
   * Registers this OpenClaw runtime in Aillium Core.
   * Ownership and policy enforcement remain in Aillium Core.
   */
  register(input: RuntimeRegistrationInput): Promise<RuntimeRegistrationResult>;
}

export interface ContractAdapter {
  /**
   * Maps OpenClaw command/request payloads to Aillium-facing contracts.
   */
  toExternalContract(input: JsonValue, metadata?: TenantSessionMetadata): Promise<JsonValue>;

  /**
   * Maps Aillium callback payloads back into OpenClaw-compatible contract shape.
   */
  fromExternalContract(input: JsonValue, metadata?: TenantSessionMetadata): Promise<JsonValue>;
}

export interface EvidenceCallbackHook {
  /**
   * Emits evidence/provenance events to Aillium systems.
   */
  onEvidence(
    eventName: string,
    payload: JsonValue,
    metadata?: TenantSessionMetadata,
  ): Promise<void>;
}

export interface TenantSessionMetadataAdapter {
  /**
   * Pass-through metadata projection for tenant/session context.
   *
   * Must not become tenancy ownership logic inside OpenClaw.
   */
  project(metadata: TenantSessionMetadata): Promise<TenantSessionMetadata>;
}

export interface AilliumIntegrationBoundary {
  runtimeRegistration: RuntimeRegistrationAdapter;
  contractAdapter: ContractAdapter;
  evidenceHooks: readonly EvidenceCallbackHook[];
  tenantSessionMetadata: TenantSessionMetadataAdapter;
}
