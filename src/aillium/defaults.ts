import type {
  AilliumIntegrationBoundary,
  CapsuleLifecycleEvent,
  CapsuleLifecycleHook,
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

class NoopRuntimeRegistrationAdapter implements RuntimeRegistrationAdapter {
  async register(_input: RuntimeRegistrationInput): Promise<RuntimeRegistrationResult> {
    return { registered: false, message: "No Aillium runtime registration adapter configured" };
  }
}

class IdentityContractAdapter implements ContractAdapter {
  async toExternalContract(input: JsonValue): Promise<JsonValue> {
    return input;
  }

  async fromExternalContract(input: JsonValue): Promise<JsonValue> {
    return input;
  }
}

class NoopEvidenceCallbackHook implements EvidenceCallbackHook {
  async onEvidence(
    _eventName: string,
    _payload: JsonValue,
    _metadata?: TenantSessionMetadata,
  ): Promise<void> {
    // Intentionally no-op until an Aillium callback transport is provided.
  }
}

class IdentityTenantSessionMetadataAdapter implements TenantSessionMetadataAdapter {
  async project(metadata: TenantSessionMetadata): Promise<TenantSessionMetadata> {
    return metadata;
  }
}

class NoopContextLifecycleHook implements ContextLifecycleHook {
  async onContextLifecycle(_event: ContextLifecycleEvent): Promise<void> {
    // No-op until Aillium Core context lifecycle transport is configured.
  }
}

class NoopCapsuleLifecycleHook implements CapsuleLifecycleHook {
  async onCapsuleLifecycle(_event: CapsuleLifecycleEvent): Promise<void> {
    // No-op until Aillium Core capsule lifecycle transport is configured.
  }
}

export function createDefaultAilliumBoundary(): AilliumIntegrationBoundary {
  return {
    runtimeRegistration: new NoopRuntimeRegistrationAdapter(),
    contractAdapter: new IdentityContractAdapter(),
    evidenceHooks: [new NoopEvidenceCallbackHook()],
    tenantSessionMetadata: new IdentityTenantSessionMetadataAdapter(),
    contextLifecycle: new NoopContextLifecycleHook(),
    capsuleLifecycle: new NoopCapsuleLifecycleHook(),
  };
}
