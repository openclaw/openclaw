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

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
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
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const provenance = OPS_PROVENANCE;
      const note = `[OpenClaw: 2 ${description} from 2026-10-10T22:30:29.302Z to 2026-10-10T22:30:43.592Z, using "mock/mock-model". Their contents are not included here. Before answering a question that may depend on these messages, call mcp__openclaw__sessions_history({"sessionKey":"agent:main:switch-back","limit":100}) to read them; page older messages with offset if needed.]`;
      const raw = `${note}\n\n${envelope()}\nPlease check the build.`;
      const content = [{ type: "text", text: raw }];
      await writeClaudeEntries(filePath, [claudeUser(content, { uuid: "routed-switch-back" })]);

      const merged = merge([], await readMessages());

      expect(merged).toMatchObject([{ role: "user", content, provenance }]);
      expect(merged[0]).not.toMatchObject({ senderIsOwner: true });
    });
  });

  it("records inter-session provenance from the routed prompt envelope", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const provenance: InputProvenance = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceChannel: "webchat",
        sourceTool: "sessions_send",
      };
      const text = envelope(provenance);
      await writeClaudeEntries(filePath, [
        claudeUser(`${text}\n${DRIFT_NOTE}\nPlease check the build.`, { uuid: "routed-1" }),
        claudeUser([{ type: "text", text: `${text}\nBlock body.` }], { uuid: "routed-2" }),
        claudeUser(
          `[Inter-session message] sourceTool=sessions_send isUser=false\nTyped by hand.`,
          { uuid: "look-alike-1" },
        ),
      ]);

      const messages = await readMessages();

      expect(messages).toMatchObject([
        {
          role: "user",
          content: `${text}\n${DRIFT_NOTE}\nPlease check the build.`,
          provenance,
        },
        { role: "user", content: [{ type: "text", text: `${text}\nBlock body.` }], provenance },
        { role: "user" },
      ]);
      expect(messages[2]?.provenance).toBeUndefined();
    });
  });

  it("matches literal routed text block requester frame before removing generated-looking decorations", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
      const provenance = OPS_PROVENANCE;
      const quoted = `${REQUESTER_FRAME}${REQUESTER_HINT}\n\nPlease check the build.`;
      const content = [{ type: "text", text: `${envelope()}\n${quoted}` }];
      const plain = { ...user("Please check the build."), provenance };
      const literal = { ...user([{ type: "text", text: quoted }]), provenance };
      await writeClaudeEntries(filePath, [claudeUser(content, { uuid: "routed-literal" })]);

      const imported = await readMessages();
      const merged = merge([plain, literal], imported);

      expect(merged).toEqual([
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

  it("matches repeated ordinary turns in order across different generated context", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
      const context =
        'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"requester_profile":{"id":"owner"},"requester_profile_hint":"current"}\n```\n\n';
      const first = user(`${context}hello`);
      const second = user("hello");
      await writeClaudeEntries(filePath, [
        claudeUser(`${DRIFT_NOTE}\n\nhello`, { uuid: "first" }),
        claudeUser("hello", { uuid: "second" }),
      ]);

      expect(merge([first, second], await readMessages())).toEqual([
        { ...first, __openclaw: cliMeta("first", sessionId) },
        { ...second, __openclaw: cliMeta("second", sessionId) },
      ]);
    });
  });

  it("dedupes routed prompts whose drift note sits under the inter-session envelope", () => {
    const provenance: InputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    };
    const settleProvenance: InputProvenance = {
      kind: "inter_session",
      sourceTool: "subagent_settle",
    };
    const local = routed(
      `${envelope(provenance)}\nPlease check the build.`,
      1_000,
      undefined,
      provenance,
    );
    const settled = routed(
      "[Subagent Context] Every subagent has settled.",
      2_000,
      undefined,
      settleProvenance,
    );
    const imports = [
      user(
        `${envelope(provenance)}\n${DRIFT_NOTE}\nPlease check the build.`,
        1_001,
        cliMeta("routed"),
      ),
      user(
        `${envelope(settleProvenance)}\n[Subagent Context] Every subagent has settled.`,
        2_001,
        cliMeta("settled"),
      ),
    ];
    expect(merge([local, settled], imports)).toEqual([
      { ...local, __openclaw: cliMeta("routed") },
      { ...settled, __openclaw: cliMeta("settled") },
    ]);
  });

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
