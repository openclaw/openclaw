import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildTestCtx } from "./test-ctx.js";

const { handleApproveCommandFromContextMock } = vi.hoisted(() => ({
  handleApproveCommandFromContextMock: vi.fn(),
}));

vi.mock("./commands-approve.js", () => ({
  handleApproveCommandFromContext: (...args: unknown[]) =>
    handleApproveCommandFromContextMock(...args),
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

describe("tryFastApproveFromMessage", () => {
  beforeEach(() => {
    handleApproveCommandFromContextMock.mockReset();
    handleApproveCommandFromContextMock.mockResolvedValue({
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

  it("never submits a suppressed approval command even when command access allows it", async () => {
    const ctx = buildTestCtx({
      Body: command,
      CommandBody: command,
      CommandAuthorized: true,
      CommandInterpretationSuppressed: true,
    });
    const cfg = { commands: { allowFrom: { "*": ["*"] } } } satisfies OpenClawConfig;

    await expect(approve(ctx, { cfg })).resolves.toEqual({ handled: false });
    expect(handleApproveCommandFromContextMock).not.toHaveBeenCalled();
  });

  it("does not promote a quoted approval command from an arbitrary message line", async () => {
    const ctx = approvalContext({
      Body: "Please explain this command:\n/approve exec-1 allow-once",
      CommandBody: "Please explain this command:\n/approve exec-1 allow-once",
    });

    await expect(approve(ctx)).resolves.toEqual({ handled: false });
    expect(handleApproveCommandFromContextMock).not.toHaveBeenCalled();
  });
});
