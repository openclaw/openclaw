import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTestCtx } from "./test-ctx.js";

const { handleApproveCommandFromContextMock } = vi.hoisted(() => ({
  handleApproveCommandFromContextMock: vi.fn(),
}));

vi.mock("./commands-approve.js", () => ({
  handleApproveCommandFromContext: handleApproveCommandFromContextMock,
}));

const { tryFastApproveFromMessage } = await import("./fast-approve.js");

const command = "/approve exec-1 allow-once";
function approve(
  ctx: ReturnType<typeof buildTestCtx>,
  overrides: Partial<Parameters<typeof tryFastApproveFromMessage>[0]> = {},
) {
  return tryFastApproveFromMessage({ ctx, cfg: {}, ...overrides });
}
function expectDelegated(expected: {
  commandBodyNormalized?: string;
  isAuthorizedSender?: boolean;
}) {
  expect(handleApproveCommandFromContextMock).toHaveBeenCalledWith(
    expect.objectContaining({ command: expect.objectContaining(expected) }),
    true,
  );
}
function approvalContext(overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildTestCtx({
    Body: command,
    CommandBody: command,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "imessage",
    Surface: "imessage",
    ChatType: "direct",
    ...overrides,
  });
}

beforeEach(() => {
  handleApproveCommandFromContextMock.mockReset().mockResolvedValue({
    shouldContinue: false,
    reply: { text: "Approval submitted." },
  });
});

it.each([true, false])("uses canonical approval text (external=%s)", async (external) => {
  const ctx = approvalContext(
    external
      ? { BodyForCommands: command }
      : { Body: "[Replying to an approval prompt]\nquoted approval text" },
  );
  await expect(
    approve(
      ctx,
      external ? { agentId: "main", sessionKey: "agent:main:imessage:direct:peer" } : {},
    ),
  ).resolves.toEqual({ handled: true, reply: { text: "Approval submitted." } });
  expectDelegated({
    commandBodyNormalized: command,
    ...(external ? { isAuthorizedSender: true } : {}),
  });
});

it("keeps authorization in the approval command owner", async () => {
  handleApproveCommandFromContextMock.mockResolvedValue({ shouldContinue: false });
  const ctx = approvalContext({ CommandAuthorized: false });

  await expect(approve(ctx)).resolves.toEqual({ handled: true });
  expectDelegated({ isAuthorizedSender: false });
});

it.each([
  {
    name: "suppressed despite command access",
    context: { CommandInterpretationSuppressed: true },
    cfg: { commands: { allowFrom: { "*": ["*"] } } } satisfies OpenClawConfig,
  },
  {
    name: "quoted on an arbitrary line",
    context: {
      Body: "Please explain this command:\n/approve exec-1 allow-once",
      CommandBody: "Please explain this command:\n/approve exec-1 allow-once",
    },
    cfg: {},
  },
])("never submits an approval $name", async ({ context, cfg }) => {
  await expect(approve(approvalContext(context), { cfg })).resolves.toEqual({ handled: false });
  expect(handleApproveCommandFromContextMock).not.toHaveBeenCalled();
});
