import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCliSessionDriftNote } from "../agents/cli-session.js";
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

function writeClaudeEntries(filePath: string, entries: readonly Record<string, unknown>[]) {
  return fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

describe("routed CLI prompts in chat history", () => {
  it("records inter-session provenance from the routed prompt envelope", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      const envelope = buildInterSessionPromptContext({
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceChannel: "webchat",
        sourceTool: "sessions_send",
      }).text;
      await writeClaudeEntries(filePath, [
        claudeUser(`${envelope}\n${DRIFT_NOTE}\nPlease check the build.`, {
          uuid: "routed-1",
        }),
        claudeUser([{ type: "text", text: `${envelope}\nBlock body.` }], { uuid: "routed-2" }),
        claudeUser(
          `[Inter-session message] sourceTool=sessions_send isUser=false\nTyped by hand.`,
          {
            uuid: "look-alike-1",
          },
        ),
      ]);

      const messages = await readMessages();

      const provenance = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:main",
        sourceChannel: "webchat",
        sourceTool: "sessions_send",
      };
      expect(messages).toMatchObject([
        {
          role: "user",
          content: `${envelope}\n${DRIFT_NOTE}\nPlease check the build.`,
          provenance,
        },
        { role: "user", content: [{ type: "text", text: `${envelope}\nBlock body.` }], provenance },
        { role: "user" },
      ]);
      expect(messages[2]?.provenance).toBeUndefined();
    });
  });

  it.each(["string", "text block"])(
    "matches literal routed %s content before removing generated-looking decorations",
    async (shape) => {
      await withClaudeProjectsDir(async ({ filePath, readMessages, sessionId }) => {
        const provenance: InputProvenance = {
          kind: "inter_session",
          sourceSessionKey: "agent:ops:main",
          sourceTool: "sessions_send",
        };
        const envelope = buildInterSessionPromptContext(provenance).text;
        const body = `${envelope}\nPlease check the build.`;
        const raw = `${envelope}\n${DRIFT_NOTE}\nPlease check the build.`;
        const content = shape === "string" ? raw : [{ type: "text", text: raw }];
        const plain = { ...user(body), provenance };
        const literal = { ...user(content), provenance };
        await writeClaudeEntries(filePath, [claudeUser(content, { uuid: "routed-literal" })]);

        const imported = await readMessages();
        const merged = mergeImportedChatHistoryMessages({
          localMessages: [plain, literal],
          importedMessages: imported,
        });

        expect(merged).toEqual([
          plain,
          { ...literal, __openclaw: cliMeta("routed-literal", sessionId) },
        ]);
        expect(imported[0]?.content).toEqual(content);
      });
    },
  );

  it("dedupes routed prompts whose drift note sits under the inter-session envelope", () => {
    const envelope = buildInterSessionPromptContext({
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    }).text;
    const provenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:main:main",
      sourceTool: "sessions_send",
    };
    const routed = { ...user(`${envelope}\nPlease check the build.`, 1_000), provenance };
    const settled = {
      ...user("[Subagent Context] Every subagent has settled.", 2_000),
      provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
    };
    const importedRouted = user(
      `${envelope}\n${DRIFT_NOTE}\nPlease check the build.`,
      1_001,
      cliMeta("routed"),
    );
    const settleEnvelope = buildInterSessionPromptContext({
      kind: "inter_session",
      sourceTool: "subagent_settle",
    }).text;
    const importedSettled = user(
      `${settleEnvelope}\n[Subagent Context] Every subagent has settled.`,
      2_001,
      cliMeta("settled"),
    );

    const merged = mergeImportedChatHistoryMessages({
      localMessages: [routed, settled],
      importedMessages: [importedRouted, importedSettled],
    });

    expect(merged).toEqual([
      { ...routed, __openclaw: cliMeta("routed") },
      { ...settled, __openclaw: cliMeta("settled") },
    ]);
  });

  it("keeps equal routed bodies from different source sessions apart", () => {
    const routedFrom = (sourceSessionKey: string) => ({
      envelope: buildInterSessionPromptContext({
        kind: "inter_session",
        sourceSessionKey,
        sourceTool: "sessions_send",
      }).text,
      provenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
    });
    const ops = routedFrom("agent:ops:main");
    const finance = routedFrom("agent:finance:main");
    const localWithEnvelope = {
      ...user(`${ops.envelope}\ndone`, 1_000),
      provenance: ops.provenance,
    };
    const localBodyOnly = { ...user("done", 1_000_000), provenance: ops.provenance };
    const importedFinance = {
      ...user(`${finance.envelope}\ndone`, 1_001, cliMeta("finance-1")),
      provenance: finance.provenance,
    };
    const importedFinanceLater = {
      ...user(`${finance.envelope}\ndone`, 1_000_001, cliMeta("finance-2")),
      provenance: finance.provenance,
    };
    const importedOps = {
      ...user(`${ops.envelope}\ndone`, 1_000_002, cliMeta("ops-2")),
      provenance: ops.provenance,
    };

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localWithEnvelope, localBodyOnly],
        importedMessages: [importedFinance, importedFinanceLater, importedOps],
      }),
    ).toEqual([
      localWithEnvelope,
      importedFinance,
      { ...localBodyOnly, __openclaw: cliMeta("ops-2") },
      importedFinanceLater,
    ]);
  });

  it("keeps an owner message apart from a routed message with the same body", () => {
    const provenance: InputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:ops:main",
      sourceTool: "sessions_send",
    };
    const envelope = buildInterSessionPromptContext(provenance).text;
    const owner = user("done", 1_000);
    const importedRouted = {
      ...user(`${envelope}\ndone`, 1_001, cliMeta("routed")),
      provenance,
    };

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [owner],
        importedMessages: [importedRouted],
      }),
    ).toEqual([owner, importedRouted]);
  });

  it("dedupes routed prompts carrying queued system event lines", () => {
    const provenance: InputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:ops:main",
      sourceTool: "sessions_send",
    };
    const envelope = buildInterSessionPromptContext(provenance).text;
    const local = { ...user("what changed?", 1_000), provenance };
    const imported = {
      ...user(
        `${envelope}\nSystem: [2026-09-30 17:16:38 UTC] Gateway connected.\n\nwhat changed?`,
        1_001,
        cliMeta("routed-events"),
      ),
      provenance,
    };

    expect(
      mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
    ).toEqual([{ ...local, __openclaw: cliMeta("routed-events") }]);
  });

  it("dedupes a body-only routed row against an import with a drift note", () => {
    const provenance: InputProvenance = {
      kind: "inter_session",
      sourceSessionKey: "agent:ops:main",
      sourceTool: "sessions_send",
    };
    const envelope = buildInterSessionPromptContext(provenance).text;
    const local = { ...user("Please check the build.", 1_000), provenance };
    const imported = user(
      `${envelope}\n${DRIFT_NOTE}\nPlease check the build.`,
      1_001,
      cliMeta("routed-drift"),
    );

    expect(
      mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
    ).toEqual([{ ...local, __openclaw: cliMeta("routed-drift") }]);
  });

  it("keeps typed System lines as part of the prompt", () => {
    const local = user("what changed?", 1_000);
    const imported = user("System: review the logs\n\nwhat changed?", 1_001, cliMeta("typed"));

    expect(
      mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
    ).toEqual([local, imported]);
  });

  it("keeps typed bracketed System lines apart from an unrelated local turn", () => {
    const local = user("done", 1_000);
    const imported = user("System: [manual note]\n\ndone", 1_001, cliMeta("bracketed"));

    expect(
      mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
    ).toEqual([local, imported]);
  });

  it("strips queued system event lines with UTC and unknown timestamps", () => {
    const local = user("done", 1_000);
    const imported = user(
      "System: [2026-09-30T17:16:38Z] Gateway connected.\nSystem: [unknown-time] Node paired.\n\ndone",
      1_001,
      cliMeta("utc-events"),
    );

    expect(
      mergeImportedChatHistoryMessages({ localMessages: [local], importedMessages: [imported] }),
    ).toEqual([{ ...local, __openclaw: cliMeta("utc-events") }]);
  });

  it("dedupes prompts carrying queued system event lines", () => {
    const localMessage = user("what changed?", 1_000);
    const importedMessage = user(
      `${DRIFT_NOTE}\n\nSystem: [2026-09-30 17:16:38 UTC] Gateway connected.\nSystem: second line\n\nwhat changed?`,
      1_001,
      cliMeta("system-events"),
    );

    expect(
      mergeImportedChatHistoryMessages({
        localMessages: [localMessage],
        importedMessages: [importedMessage],
      }),
    ).toEqual([{ ...localMessage, __openclaw: cliMeta("system-events") }]);
  });
});
