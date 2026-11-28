// Gateway-started turns may show the project list; only the tool decides who may move the chat.
import { expect, it, vi } from "vitest";
import { createSessionProjectTool } from "./session-project-tool.js";

vi.mock("./gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: () => ({
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:1222",
  }),
  resolveGatewayToolOperatorSelection: () => ({}),
}));
vi.mock("./in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./in-process-gateway.js")>()),
  getInProcessGatewayToolContext: () => ({ getRuntimeConfig: () => ({}) }),
}));

it("refuses a turn that no owner or operator drives, such as an automation or peer turn", async () => {
  const tool = createSessionProjectTool({ sessionId: "chat", senderIsOwner: false });

  for (const args of [{ action: "move", projectId: "website" }, { action: "list" }]) {
    await expect(tool.execute("call", args, undefined)).rejects.toThrow(
      "Only the owner can move this conversation into a project.",
    );
  }
});
