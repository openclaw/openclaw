import { expect, it } from "vitest";
import { parseStoredDraft } from "./composer-draft-store-codec.ts";
import { composerFileReferenceFixture } from "./file-references.test-support.ts";

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

function identityDraft(fileReferences: unknown) {
  return {
    key: "reference-draft",
    ownerKey: "owner",
    gatewayOwner: "gateway",
    recoveryScope: "scope",
    scopeKey: "reference-scope",
    updatedAt: 1,
    writeId: "write",
    text: "@src/example.ts",
    revision: 1,
    attachments: [],
    fileReferences,
  };
}

it("retains the canonical opaque identity and exact text binding when decoding a draft", () => {
  const decoded = parseStoredDraft(identityDraft([composerFileReferenceFixture]));
  expect(decoded?.fileReferences).toEqual([composerFileReferenceFixture]);
  expect(decoded?.fileReferences?.[0]?.reference.objectId).toBe("opaque-file-one");
});

it.each([
  {
    ...composerFileReferenceFixture,
    reference: {
      ...composerFileReferenceFixture.reference,
      schemaVersion: 2,
      futureIdentity: "retain",
    },
  },
  {
    ...composerFileReferenceFixture,
    reference: { ...composerFileReferenceFixture.reference, objectId: "" },
  },
  { ...composerFileReferenceFixture, end: 14 },
])("refuses an unreadable reference without mutating its stored bytes", (reference) => {
  const stored = identityDraft([reference]);
  const bytes = JSON.stringify(stored);
  expect(parseStoredDraft(stored)).toBeNull();
  expect(JSON.stringify(stored)).toBe(bytes);
});
