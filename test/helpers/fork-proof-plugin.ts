import fs from "node:fs/promises";
import path from "node:path";

export const FORK_PROBE = "FORK-PROBE background review";
export const FORK_PLUGIN_ID = "prefix-fork-proof";

const SOURCE = `module.exports = { id: "${FORK_PLUGIN_ID}", register(api) {
  const turns = new Map();
  api.on("agent_end", (_event, ctx) => {
    if (ctx.completedTurn) turns.set(ctx.sessionKey, ctx.completedTurn);
  });
  api.registerTool(() => ({
    name: "prefix_fork_note",
    description: "Record one note about the conversation",
    parameters: { type: "object", properties: { note: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: "noted" }] }),
  }), { name: "prefix_fork_note" });
  api.registerGatewayMethod("prefixfork.run", async ({ params, respond }) => {
    try {
      const through = params.latest ? undefined : turns.get(params.sessionKey);
      if (!through && !params.latest) throw new Error("No completed parent turn");
      const result = await api.runtime.subagent.runForkedTurn({
        sessionKey: params.sessionKey,
        through,
        prompt: "${FORK_PROBE}",
        tools: params.tools ?? [],
        onSettled: async (outcome) => {
          if (!outcome.ok) throw outcome.error;
          return "fork-settled";
        },
      });
      respond(true, result);
    } catch (error) {
      respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
    }
  }, { scope: "operator.write" });
} };`;

export async function writeForkProofPlugin(root: string) {
  const dir = path.join(root, FORK_PLUGIN_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: FORK_PLUGIN_ID,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: FORK_PLUGIN_ID,
      activation: { onStartup: true },
      contracts: { tools: ["prefix_fork_note"] },
      configSchema: { type: "object" },
    }),
  );
  await fs.writeFile(path.join(dir, "index.cjs"), SOURCE);
  return dir;
}
