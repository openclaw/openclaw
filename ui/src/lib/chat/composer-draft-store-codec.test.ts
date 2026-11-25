import { expect, it } from "vitest";
import { parseStoredDraft } from "./composer-draft-store-codec.ts";

it("loads a stored draft that still carries the retired remembered Daybreak color", () => {
  const draft = parseStoredDraft({
    key: "draft",
    ownerKey: "owner",
    gatewayOwner: "gateway",
    recoveryScope: "scope",
    scopeKey: "scope-key",
    updatedAt: 1,
    writeId: "write",
    text: "hello",
    revision: 1,
    attachments: [],
    modelSelection: {
      agentId: "main",
      model: "openai/gpt-6-cyber",
      thinkingLevel: "high",
      cyberAccessProgram: "daybreak_red",
      daybreakAccessProgram: "daybreak_blue",
    },
  });

  expect(draft?.text).toBe("hello");
  expect(draft?.modelSelection).toEqual({
    agentId: "main",
    model: "openai/gpt-6-cyber",
    thinkingLevel: "high",
    cyberAccessProgram: "daybreak_red",
  });
  expect(draft?.modelSelection).not.toHaveProperty("daybreakAccessProgram");
});
