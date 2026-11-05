import { describe, expect, it, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";

type AccessNoticeFixture = {
  createMinimalRun: (params?: {
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
    sessionCtx: Partial<TemplateContext>;
    runOverrides: Partial<FollowupRun["run"]>;
  }) => { run: () => Promise<ReplyPayload | ReplyPayload[] | undefined> };
  makeSessionFixture: (overrides: Partial<SessionEntry>) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  state: { runEmbeddedAgentMock: Mock };
};

export function registerAccessProgramNoticeCases({
  createMinimalRun,
  makeSessionFixture,
  state,
}: AccessNoticeFixture): void {
  describe("runReplyAgent Access notice", () => {
    it("tells a direct chat once that a saved Daybreak choice did not apply to a non-OpenAI model", async () => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
        modelProvider: "anthropic",
        model: "claude",
        cyberAccessProgram: "daybreak_blue",
      });
      state.runEmbeddedAgentMock.mockResolvedValue({
        payloads: [{ text: "final" }],
        meta: {},
      });
      const runOnce = async () =>
        await createMinimalRun({
          sessionEntry,
          sessionStore,
          storePath,
          sessionCtx: { ChatType: "direct" },
          runOverrides: { cyberAccessProgram: "daybreak_blue" },
        }).run();

      expect(await runOnce()).toEqual([
        expect.objectContaining({
          text: "Daybreak Blue applies only to OpenAI models, so anthropic/claude used Standard access. Your Daybreak Blue choice is kept for when this chat returns to an OpenAI model.",
          isFallbackNotice: true,
        }),
        expect.objectContaining({ text: "final" }),
      ]);
      expect(await runOnce()).toEqual(expect.objectContaining({ text: "final" }));
    });
  });
}
