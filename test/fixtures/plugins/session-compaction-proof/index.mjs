// Test-only observer: the capability and its retirement checks are supplied by the real host.
export default {
  id: "session-compaction-proof",
  register(api) {
    let retained;
    let current;
    api.registerTool(
      (context) => {
        const capability = context.sessionCompaction;
        if (!capability) {
          return null;
        }
        current = capability;
        return {
          name: "capture_compaction_capability",
          label: "Capture Compaction Capability",
          description: "Retain this tool generation's host capability for the retirement proof.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            retained = capability;
            return {
              content: [{ type: "text", text: "Captured the current host capability." }],
              details: { captured: true },
            };
          },
        };
      },
      { names: ["capture_compaction_capability"], optional: true },
    );
    api.registerGatewayMethod(
      "compaction-proof.retained",
      ({ respond }) => {
        if (!retained || !current) {
          respond(true, { captured: false });
          return;
        }
        const control = { captured: true, differentGeneration: current !== retained };
        try {
          control.currentStatus = current.request({}).status;
          control.currentAllowed = true;
        } catch {
          respond(true, { ...control, currentAllowed: false });
          return;
        }
        try {
          const result = retained.request({
            focus: "A retired generation must not rewrite history.",
          });
          respond(true, { ...control, rejected: false, result });
        } catch (error) {
          respond(true, {
            ...control,
            rejected: true,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
      },
      { scope: "operator.admin" },
    );
  },
};
