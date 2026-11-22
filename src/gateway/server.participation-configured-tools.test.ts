import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

it("adds a configured plugin to participant defaults and denies openclaw exact-id dispatch", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, providerReplies }) => {
      const { key } = await sender.request<{ key: string }>(
        "sessions.create",
        { agentId: "main", label: "Configured participation", visibility: "shared" },
        { signal },
      );
      const target = { agentId: "main", sessionKey: key };
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "send" },
        { signal },
      );
      const prompt = "Run the configured participant tool proof.";
      const outputs: string[] = [];
      const listings: string[][] = [];
      let step = 0;
      providerReplies.reply = (body, response) => {
        const request = JSON.parse(body) as {
          input: Array<{ type?: string; output?: string }>;
          tools: Array<{ name: string }>;
        };
        if (body.includes(prompt)) {
          listings.push(request.tools.map((tool) => tool.name));
          const output = request.input.findLast(
            (item) => item.type === "function_call_output",
          )?.output;
          if (output) {
            outputs.push(output);
          }
          const action = [
            ["tool_describe", { id: "openclaw:participant-proof:participant_probe" }],
            ["dispatch_action", { id: "openclaw:participant-proof:participant_probe", args: {} }],
            ["dispatch_action", { id: "openclaw:core:openclaw", args: {} }],
          ] as const;
          const next = action[step++];
          if (next) {
            writeToolCall(response, next[0], next[1]);
            return;
          }
        }
        writeOpenAiResponsesText(response, {
          text: "Proof complete.",
          messageId: "configured-result",
          responseId: "configured-response",
        });
      };
      const runId = "configured-participant-proof";
      await invited.request(
        "chat.send",
        { ...target, message: prompt, idempotencyKey: runId },
        { signal },
      );
      await expect(sender.request("agent.wait", { runId }, { signal })).resolves.toMatchObject({
        status: "ok",
      });
      expect(outputs).toHaveLength(3);
      expect(outputs[0]).toContain("participant_probe");
      const executed = JSON.parse(outputs[1]!) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(executed.result.content[0]!.text)).toMatchObject({
        owner: false,
      });
      expect(outputs[2]).toMatch(/not found|unknown|unavailable/i);
      expect(listings[0]).toContain("read");
      expect(listings.every((tools) => !tools.includes("openclaw"))).toBe(true);
    },
    {
      maxInvitedAccess: "send",
      invitedAlsoAllow: ["participant-proof", "openclaw"],
      tools: {
        allow: [
          "read",
          "participant-proof",
          "tool_search",
          "tool_describe",
          "dispatch_action",
          "openclaw",
        ],
        toolSearch: { enabled: true },
      },
      setupPlugins: async (state) => {
        await state.writeJson("participant-plugin/package.json", {
          name: "participant-proof",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await state.writeJson("participant-plugin/openclaw.plugin.json", {
          id: "participant-proof",
          activation: { onStartup: true },
          contracts: { tools: ["participant_probe"] },
          configSchema: { type: "object", additionalProperties: false },
        });
        await state.writeText(
          "participant-plugin/index.cjs",
          `module.exports = { id: "participant-proof", register(api) {
        api.registerTool({ contextVersion: 2, create(context) { return {
          name: "participant_probe", description: "Report admitted participant identity", parameters: {type: "object", properties: {}},
          async execute() { context.assertInvocationCurrent(); const facts = { owner: context.senderIsOwner }; return { content: [{type: "text", text: JSON.stringify(facts)}], details: facts }; }
        }; } }, { name: "participant_probe" });
      } };`,
        );
        return {
          slots: { memory: "none" },
          allow: ["participant-proof"],
          load: { paths: [state.statePath("participant-plugin")] },
        };
      },
    },
  );
});
