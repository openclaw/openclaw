import { beforeEach, expect, it, vi } from "vitest";
import { buildTestCtx } from "./test-ctx.js";

const submit = vi.hoisted(() => vi.fn());

// mock-isolation: Test the approval handoff without loading Gateway approval execution.
vi.mock("./commands-approve.js", () => ({
  handleApproveCommandFromContext: submit,
}));

const { tryFastApproveFromMessage } = await import("./fast-approve.js");

const command = "/approve exec-1 allow-once";
function approve(
  context: Parameters<typeof buildTestCtx>[0],
  overrides: Partial<Parameters<typeof tryFastApproveFromMessage>[0]> = {},
) {
  return tryFastApproveFromMessage({
    ctx: buildTestCtx({
      Body: command,
      CommandBody: command,
      CommandAuthorized: true,
      Provider: "imessage",
      Surface: "imessage",
      ...context,
    }),
    cfg: {},
    ...overrides,
  });
}
function expectDelegated(expected: {
  commandBodyNormalized?: string;
  isAuthorizedSender?: boolean;
}) {
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ command: expect.objectContaining(expected) }),
    true,
  );
}
beforeEach(() => {
  submit.mockReset().mockResolvedValue({
    shouldContinue: false,
    reply: { text: "Approval submitted." },
  });
});

it.each([true, false])("uses canonical approval text (external=%s)", async (external) => {
  await expect(
    approve(
      external
        ? { BodyForCommands: command }
        : { Body: "[Replying to an approval prompt]\nquoted approval text" },
      external ? { agentId: "main", sessionKey: "agent:main:imessage:direct:peer" } : {},
    ),
  ).resolves.toEqual({ handled: true, reply: { text: "Approval submitted." } });
  expectDelegated({
    commandBodyNormalized: command,
    ...(external ? { isAuthorizedSender: true } : {}),
  });
});

it("keeps authorization in the approval command owner", async () => {
  submit.mockResolvedValue({ shouldContinue: false });
  await expect(approve({ CommandAuthorized: false })).resolves.toEqual({ handled: true });
  expectDelegated({ isAuthorizedSender: false });
});

const quoted = "Please explain this command:\n/approve exec-1 allow-once";
it.each([{ CommandInterpretationSuppressed: true }, { Body: quoted, CommandBody: quoted }])(
  "never submits a suppressed or quoted approval: %j",
  async (context) => {
    const cfg = { commands: { allowFrom: { "*": ["*"] } } };
    await expect(approve(context, { cfg })).resolves.toEqual({ handled: false });
    expect(submit).not.toHaveBeenCalled();
  },
);
