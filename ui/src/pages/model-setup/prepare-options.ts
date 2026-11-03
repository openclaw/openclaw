import type { SystemAgentSetupDetectResult } from "../../api/types.ts";

export type ModelSetupPrepareOption = NonNullable<
  SystemAgentSetupDetectResult["prepareOptions"]
>[number];

/** Keep discovery-only metadata out of activation RPC payloads. */
export function candidateActivation({
  kind,
  modelRef,
  modelTarget,
}: Pick<SystemAgentSetupDetectResult["candidates"][number], "kind" | "modelRef" | "modelTarget">) {
  return { kind, modelRef, ...(modelTarget ? { modelTarget } : {}) };
}

function providerAutoSetupKind(choiceId: string): `provider-auto:${string}` {
  return `provider-auto:${encodeURIComponent(choiceId)}`;
}

export function preparedModelActivation(option: ModelSetupPrepareOption, modelRef: string) {
  return {
    kind: providerAutoSetupKind(option.id),
    modelRef,
    ...(option.modelTarget ? { modelTarget: option.modelTarget } : {}),
  };
}

export function hasReachableModelSetupService(
  result: SystemAgentSetupDetectResult,
  option: { id: string; brandId?: string },
): boolean {
  return (result.prepareOptions ?? []).some(
    (choice) =>
      choice.serviceReachable === true &&
      (choice.brandId ?? choice.id) === (option.brandId ?? option.id),
  );
}

export function listModelSetupPrepareOptions(
  result: SystemAgentSetupDetectResult,
): ModelSetupPrepareOption[] {
  return (result.prepareOptions ?? []).filter(
    (choice) =>
      !result.candidates.some(
        (candidate) =>
          candidate.credentials !== false &&
          !(choice.serviceReachable && candidate.kind === "existing-model") &&
          (candidate.kind === providerAutoSetupKind(choice.id) ||
            candidate.modelRef.startsWith(`${choice.brandId ?? choice.id}/`)),
      ),
  );
}

export function findPreparedModelCandidate(result: SystemAgentSetupDetectResult, choiceId: string) {
  // Detection deliberately encodes the provider-auth choice ID in the kind;
  // brandId owns the model-ref namespace and may differ.
  return result.candidates.find(
    (candidate) =>
      candidate.kind === providerAutoSetupKind(choiceId) && candidate.credentials !== false,
  );
}
