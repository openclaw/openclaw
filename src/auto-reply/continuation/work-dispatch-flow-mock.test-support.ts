type MockFlowBase = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  chainId?: string;
  controllerId: string;
  status: string;
  notifyPolicy: "silent";
  goal: string;
  currentStep?: string;
  stateJson?: unknown;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type MockFlowUpdate<T extends MockFlowBase> = {
  flowId: string;
  expectedRevision: number;
  patch: Partial<T>;
};

function updateMockFlowsAtomically<T extends MockFlowBase>(
  flows: Map<string, T>,
  updates: readonly MockFlowUpdate<T>[],
) {
  for (const update of updates) {
    const flow = flows.get(update.flowId);
    if (!flow || flow.revision !== update.expectedRevision) {
      return {
        applied: false as const,
        reason: flow ? ("revision_conflict" as const) : ("not_found" as const),
      };
    }
  }
  const updated = updates.map((update) => {
    const flow = flows.get(update.flowId)!;
    Object.assign(flow, update.patch, { revision: flow.revision + 1 });
    return { ...flow };
  });
  return { applied: true as const, flows: updated };
}

export function createMockFlowWithAtomicUpdates<T extends MockFlowBase>(
  flows: Map<string, T>,
  nextFlowId: () => string,
  params: {
    create: Partial<T> & Pick<T, "ownerKey">;
    updates: readonly MockFlowUpdate<T>[];
  },
) {
  const updated = updateMockFlowsAtomically(flows, params.updates);
  if (!updated.applied) {
    return updated;
  }
  const now = Date.now();
  const created = {
    flowId: nextFlowId(),
    syncMode: "managed",
    ownerKey: params.create.ownerKey,
    chainId: params.create.chainId,
    controllerId: params.create.controllerId ?? "tests/controller",
    status: params.create.status ?? "queued",
    notifyPolicy: "silent",
    goal: params.create.goal ?? "goal",
    currentStep: params.create.currentStep,
    stateJson: params.create.stateJson,
    revision: 0,
    createdAt: params.create.createdAt ?? now,
    updatedAt: params.create.updatedAt ?? params.create.createdAt ?? now,
  } as T;
  flows.set(created.flowId, created);
  return { applied: true as const, created: { ...created }, updated: updated.flows };
}

export function createAtomicTaskFlowMocks<T extends MockFlowBase>(
  getFlows: () => Map<string, T>,
  nextFlowId: () => string,
) {
  return {
    createManagedTaskFlowWithAtomicUpdates: (
      params: Parameters<typeof createMockFlowWithAtomicUpdates<T>>[2],
    ) => createMockFlowWithAtomicUpdates(getFlows(), nextFlowId, params),
    updateTaskFlowsAtomically: (updates: readonly MockFlowUpdate<T>[]) =>
      updateMockFlowsAtomically(getFlows(), updates),
  };
}
