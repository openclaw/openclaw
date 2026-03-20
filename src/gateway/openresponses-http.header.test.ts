import { describe, expect, it } from "vitest";
import { __testOnlyOpenResponsesHttp } from "./openresponses-http.js";

describe("openresponses owner header handling", () => {
  it("honors x-openclaw-sender-is-owner=false", () => {
    const command = __testOnlyOpenResponsesHttp.buildResponsesAgentCommandInput({
      req: {
        headers: {
          "x-openclaw-sender-is-owner": "false",
        },
      } as never,
      message: "hi",
      images: [],
      clientTools: [],
      extraSystemPrompt: "",
      streamParams: undefined,
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
    });

    expect(command.senderIsOwner).toBe(false);
  });

  it("defaults public-mode ingress to non-owner when the header is missing", () => {
    const command = __testOnlyOpenResponsesHttp.buildResponsesAgentCommandInput({
      req: { headers: {} } as never,
      message: "hi",
      images: [],
      clientTools: [],
      extraSystemPrompt: "",
      streamParams: undefined,
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
      publicMode: true,
    });

    expect(command.senderIsOwner).toBe(false);
  });
});
