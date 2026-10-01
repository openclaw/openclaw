// Independent consumer of the invocation-bound fork capability, intentionally not /fork.
export default {
  id: "gate-a-fork-workflow",
  register(api) {
    api.registerCommand({
      name: "gate-fork-proof",
      description: "Isolated fork placement and Back proof",
      requireAuth: true,
      handler: async (ctx) => {
        const host = ctx.runtimeContext?.conversationFork;
        if (
          host?.version !== 1 ||
          typeof host.prepare !== "function" ||
          typeof host.execute !== "function" ||
          typeof host.back !== "function"
        )
          return { text: "unavailable" };
        if (ctx.args?.trim() === "back") {
          const result = await host.back();
          return {
            text:
              result?.status === "returned"
                ? "returned"
                : "back-" + String(result?.status) + "-" + String(result?.reason ?? "none"),
          };
        }
        if (ctx.args?.trim() !== "start") return { text: "usage: start|back" };
        const plan = await host.prepare({ title: "Isolated fork proof" });
        if (plan?.status !== "ready" || typeof plan.ticket !== "string")
          return { text: "prepare-" + String(plan?.status) + "-" + String(plan?.reason ?? "none") };
        const placed = await host.execute({ ticket: plan.ticket, placement: "current" });
        return {
          text:
            placed?.status === "placed"
              ? "placed"
              : "placement-" + String(placed?.status) + "-" + String(placed?.reason ?? "none"),
        };
      },
    });
  },
};
