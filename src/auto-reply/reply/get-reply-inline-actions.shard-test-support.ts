import { runTestInlineActions } from "./get-reply-inline-actions.test-support.js";

type Input = Parameters<typeof runTestInlineActions>[0];
type Fixture = Pick<Input, "ctx" | "typing"> & {
  skillCommands?: NonNullable<Input["overrides"]>["skillCommands"];
};

export function runInlineFixture(
  fixture: Fixture,
  overrides: Input["overrides"] = {},
  command: Input["command"] = {},
) {
  return runTestInlineActions({
    ctx: fixture.ctx,
    typing: fixture.typing,
    cleanedBody: fixture.ctx.commandText,
    command: { isAuthorizedSender: true, senderIsOwner: true, ...command },
    overrides: {
      cfg: { commands: { text: true } },
      allowTextCommands: true,
      skillCommands: fixture.skillCommands,
      ...overrides,
    },
  });
}
