// Both transports run this program; the fixture evaluator independently checks its effects/report.
export const settlementRecoveryProgram = `async ({ call, reverse = false, onFailure = async () => {} }) => {
  const batch = await call("matrix_settlement_batch");
  const failures = [];
  for (const operation of reverse ? batch.operations.toReversed() : batch.operations) {
    if (operation.blocked) continue;
    const input = {
      operationId: operation.operationId,
      totalCents: operation.lines.reduce((sum, line) => sum + line.amountCents, 0),
    };
    try {
      await call("matrix_settle_operation", input);
    } catch (error) {
      const { states } = await call("matrix_inspect_settlements");
      const state = states.find(item => item.operationId === operation.operationId);
      failures.push({ operationId: operation.operationId, message: error.message, effectCount: state.effectCount });
      await onFailure();
      if (state.status === "unsettled") await call("matrix_settle_operation", input);
    }
  }
  const { states } = await call("matrix_inspect_settlements");
  const project = ({ operationId, effectCount, totalCents }) => ({ operationId, effectCount, totalCents });
  const byId = (a, b) => a.operationId.localeCompare(b.operationId);
  const settled = states.filter(state => batch.operations.some(item => item.operationId === state.operationId)
    && state.status === "settled").map(project).sort(byId);
  return { batch, failures, report: {
    batchId: batch.batchId,
    sourceLineCount: batch.operations.reduce((sum, operation) => sum + operation.lines.length, 0),
    settled,
    blocked: states.filter(state => state.status === "blocked").map(state => state.operationId).sort(),
    preserved: states.filter(state => batch.existing.some(item => item.operationId === state.operationId))
      .map(project).sort(byId),
    newEffectCount: settled.reduce((sum, state) => sum + state.effectCount, 0),
    newTotalCents: settled.reduce((sum, state) => sum + state.totalCents, 0),
  } };
}`;
