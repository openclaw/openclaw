export const FORK_PROOF_SOURCE = `module.exports = { id: "fork-proof", register(api) {
  const state = () => globalThis.forkProofState;
  // Each loaded generation records its runtime, so a test can retain a retired one.
  state().runtimes.push(api.runtime.subagent);
  api.on("agent_end", (_event, ctx) => {
    state().agentEnds.push({ sessionKey: ctx.sessionKey ?? null, completedTurn: ctx.completedTurn ?? null });
  });
  api.registerTool((ctx) => ({
    name: "fork_proof_note",
    description: "Record one note about the conversation",
    parameters: { type: "object", properties: { note: { type: "string" } } },
    execute: async (_id, args) => {
      state().toolCalls.push({
        args,
        backgroundRun: ctx.backgroundRun ?? null,
        runId: ctx.runId ?? null,
        senderIsOwner: ctx.senderIsOwner ?? null,
      });
      return { content: [{ type: "text", text: "noted" }] };
    },
  }), { name: "fork_proof_note" });
  api.registerGatewayMethod("forkproof.run", async ({ params, respond }) => {
    try {
      const result = await api.runtime.subagent.runForkedTurn({
        sessionKey: params.sessionKey,
        through: params.through,
        prompt: "Record one note about this conversation.",
        tools: params.tools,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.provider ? { provider: params.provider, model: params.model } : {}),
        onSettled: async (outcome) => {
          state().settled.push({ ...outcome, error: outcome.ok ? undefined : String(outcome.error) });
          const hold = state().hold;
          if (hold) {
            state().hold = undefined;
            hold.started.resolve();
            await hold.release;
          }
          return "settled-value";
        },
      });
      respond(true, { ok: true, result });
    } catch (error) {
      respond(true, { ok: false, message: String(error?.message ?? error) });
    }
  }, { scope: "operator.write" });
  // Starts a fork from background work that outlives the request, like a scheduler.
  api.registerGatewayMethod("forkproof.start", async ({ params, respond }) => {
    state().background = api.runtime.subagent
      .runForkedTurn({
        sessionKey: params.sessionKey,
        through: params.through,
        prompt: "Record one note about this conversation.",
        tools: ["fork_proof_note"],
        onSettled: async (outcome) => {
          state().settled.push({ ...outcome, error: outcome.ok ? undefined : String(outcome.error) });
          return "settled-value";
        },
      })
      .then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, message: String(error?.message ?? error) }),
      );
    respond(true, { started: true });
  }, { scope: "operator.write" });
} };`;

export const FORK_OTHER_SOURCE = `module.exports = { id: "fork-other", register(api) {
  api.registerTool({
    name: "fork_other_note",
    description: "Another plugin's tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "other" }] }),
  });
} };`;
