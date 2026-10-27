import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session-drift.js";
import {
  buildInterSessionPromptContext,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  claudeUser,
  cliMeta,
  mergeImportedChatHistoryMessages,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";

const DRIFT_NOTE = buildCliSessionDriftNote(["system-prompt", "prompt-tools"]);
const OPS_PROVENANCE: InputProvenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:ops:main",
  sourceTool: "sessions_send",
};
const REQUESTER_HINT =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
const REQUESTER_FRAME =
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner"}}\n```\n\n';

function withImports(
  entries: readonly Record<string, unknown>[],
  check: (messages: Record<string, unknown>[], sessionId: string) => void,
) {
  return withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
    await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    check(await readMessages(), sessionId);
  });
}

function merge(localMessages: unknown[], importedMessages: unknown[]) {
  return mergeImportedChatHistoryMessages({ localMessages, importedMessages });
}

function envelope(provenance: InputProvenance = OPS_PROVENANCE) {
  return buildInterSessionPromptContext(provenance).text;
}

function routed(
  content: string,
  timestamp: number,
  externalId?: string,
  provenance: InputProvenance = OPS_PROVENANCE,
) {
  return {
    ...user(content, timestamp, externalId ? cliMeta(externalId) : undefined),
    provenance,
  };
}

describe("routed CLI prompts in chat history", () => {
  it.each([
    "earlier messages in this chat",
    "messages recorded in this chat since your last reply here (possibly already in this session)",
  ])("preserves unmatched routed text block provenance beneath %s context", async (description) => {
    const note = `[OpenClaw: 2 ${description} from start to end. Their contents are not included here. Read history.]`;
    const content = [{ type: "text", text: `${note}\n\n${envelope()}\nPlease check the build.` }];
    await withImports([claudeUser(content, { uuid: "routed-switch-back" })], (messages) => {
      const merged = merge([], messages);
      expect(merged).toMatchObject([{ role: "user", content, provenance: OPS_PROVENANCE }]);
      expect(merged[0]).not.toMatchObject({ senderIsOwner: true });
    });
  });

  it("records inter-session provenance from the routed prompt envelope", async () => {
    const provenance: InputProvenance = {
      ...OPS_PROVENANCE,
      sourceChannel: "webchat",
    };
    const text = envelope(provenance);
    const contents = [
      `${text}\n${DRIFT_NOTE}\nPlease check the build.`,
      [{ type: "text", text: `${text}\nBlock body.` }],
      "[Inter-session message] sourceTool=sessions_send isUser=false\nTyped by hand.",
    ];
    await withImports(
      contents.map((content, index) => claudeUser(content, { uuid: `entry-${index}` })),
      (messages) => {
        expect(messages).toMatchObject(
          contents.map((content, index) =>
            index < 2 ? { role: "user", content, provenance } : { role: "user", content },
          ),
        );
        expect(messages[2]?.provenance).toBeUndefined();
      },
    );
  });

  it("matches literal routed text block requester frame before removing generated-looking decorations", async () => {
    const quoted = `${REQUESTER_FRAME}${REQUESTER_HINT}\n\nPlease check the build.`;
    const content = [{ type: "text", text: `${envelope()}\n${quoted}` }];
    const plain = { ...user("Please check the build."), provenance: OPS_PROVENANCE };
    const literal = { ...user([{ type: "text", text: quoted }]), provenance: OPS_PROVENANCE };
    await withImports([claudeUser(content, { uuid: "routed-literal" })], (imported, sessionId) => {
      expect(merge([plain, literal], imported)).toEqual([
        plain,
        { ...literal, __openclaw: cliMeta("routed-literal", sessionId) },
      ]);
      expect(imported[0]?.content).toEqual(content);
    });
  });

  it("keeps routed quotation identities from advancing the plain-body floor on reload", () => {
    const provenance = OPS_PROVENANCE;
    const quoted = `${REQUESTER_FRAME}${REQUESTER_HINT}\n\nhello`;
    const plain = { ...user("hello"), provenance };
    const literal = { ...user(quoted, undefined, cliMeta("literal")), provenance };
    const imports = [
      user(`${envelope()}\n${quoted}`, undefined, cliMeta("literal")),
      user(`${envelope()}\nhello`, undefined, cliMeta("plain")),
    ];

    expect(merge([plain, literal], imports)).toEqual([
      { ...plain, __openclaw: cliMeta("plain") },
      literal,
    ]);
  });

  it.each([
    [OPS_PROVENANCE, "Please check the build.", `${DRIFT_NOTE}\n`, true],
    [
      { kind: "inter_session", sourceTool: "subagent_settle" },
      "[Subagent Context] Every subagent has settled.",
      "",
      false,
    ],
  ] satisfies [InputProvenance, string, string, boolean][])(
    "dedupes routed prompts with provenance %j",
    (provenance, body, decoration, localEnvelope) => {
      const local = routed(
        localEnvelope ? `${envelope(provenance)}\n${body}` : body,
        1_000,
        undefined,
        provenance,
      );
      const imported = user(
        `${envelope(provenance)}\n${decoration}${body}`,
        1_001,
        cliMeta("routed"),
      );
      expect(merge([local], [imported])).toEqual([{ ...local, __openclaw: cliMeta("routed") }]);
    },
  );

  it("keeps equal routed bodies from different source sessions apart", () => {
    const finance = { ...OPS_PROVENANCE, sourceSessionKey: "agent:finance:main" };
    const localWithEnvelope = routed(`${envelope()}\ndone`, 1_000);
    const localBodyOnly = routed("done", 1_000_000);
    const importedFinance = routed(`${envelope(finance)}\ndone`, 1_001, "finance-1", finance);
    const importedFinanceLater = routed(
      `${envelope(finance)}\ndone`,
      1_000_001,
      "finance-2",
      finance,
    );
    const importedOps = routed(`${envelope()}\ndone`, 1_000_002, "ops-2");

    expect(
      merge(
        [localWithEnvelope, localBodyOnly],
        [importedFinance, importedFinanceLater, importedOps],
      ),
    ).toEqual([
      localWithEnvelope,
      importedFinance,
      { ...localBodyOnly, __openclaw: cliMeta("ops-2") },
      importedFinanceLater,
    ]);
  });

  it("keeps an owner message apart from a routed message with the same body", () => {
    const owner = user("done", 1_000);
    const importedRouted = routed(`${envelope()}\ndone`, 1_001, "routed");
    expect(merge([owner], [importedRouted])).toEqual([owner, importedRouted]);
  });

  it("dedupes routed prompts carrying queued system event lines", () => {
    const local = routed("what changed?", 1_000);
    const imported = routed(
      `${envelope()}\nSystem: [2026-09-30 17:16:38 UTC] Gateway connected.\n\nwhat changed?`,
      1_001,
      "routed-events",
    );
    expect(merge([local], [imported])).toEqual([
      { ...local, __openclaw: cliMeta("routed-events") },
    ]);
  });
});
