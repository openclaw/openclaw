import { vi } from "vitest";
import type { SkillCommandSpec } from "../../skills/types.js";
import { createHandleInlineActionsInput } from "./get-reply-inline-actions.input.test-support.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
export {
  createHandleInlineActionsInput,
  type HandleInlineActionsInput,
} from "./get-reply-inline-actions.input.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingController as createNoopTypingController } from "./typing.js";

const { createOpenClawToolsMock } = vi.hoisted(() => ({
  createOpenClawToolsMock: vi.fn(),
}));

export { createOpenClawToolsMock };

// mock-isolation: Exercise inline execution and cancellation with owned fixture tools.
vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async (...args: unknown[]) => createOpenClawToolsMock(...args),
}));

export const createTypingController = () => ({
  ...createNoopTypingController({}),
  cleanup: vi.fn(),
});

export function runTestInlineActions(params: Parameters<typeof createHandleInlineActionsInput>[0]) {
  return handleInlineActions(createHandleInlineActionsInput(params));
}

export function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0) {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

export function createInlineToolDispatchFixture<T>(params: {
  body: string;
  toolName: string;
  execute: () => Promise<T>;
  skill: Pick<SkillCommandSpec, "name" | "skillName" | "description" | "skillSource">;
  sourceFilePath: string;
  nativeChannelId?: string;
}) {
  const typing = createTypingController();
  const toolExecute = vi.fn(params.execute);
  createOpenClawToolsMock.mockReturnValue([{ name: params.toolName, execute: toolExecute }]);
  const ctx = buildTestCtx({
    Body: params.body,
    CommandBody: params.body,
    NativeChannelId: params.nativeChannelId,
  });
  const skillCommands: SkillCommandSpec[] = [
    {
      ...params.skill,
      dispatch: { kind: "tool", toolName: params.toolName, argMode: "raw" },
      sourceFilePath: params.sourceFilePath,
    },
  ];
  return { typing, toolExecute, ctx, skillCommands };
}
