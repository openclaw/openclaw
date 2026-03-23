import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { commandsHandlers } from "./commands.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const calls: RespondCall[] = [];
  const respond = ((...args: RespondCall) => {
    calls.push(args);
  }) as never;

  return {
    calls,
    invoke: async () =>
      await commandsHandlers["commands.list"]({
        params,
        respond,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: "commands.list" },
        isWebchatConnect: () => false,
      }),
  };
}

describe("commands.list handler", () => {
  it("rejects invalid params", async () => {
    const { calls, invoke } = createInvokeParams({ extra: true });
    await invoke();
    const call = calls[0];
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid commands.list params");
  });

  it("returns canonical slash commands with ACP and subagents entries", async () => {
    const { calls, invoke } = createInvokeParams({});
    await invoke();
    const call = calls[0];
    expect(call?.[0]).toBe(true);

    const payload = call?.[1] as
      | {
          commands: Array<{
            key: string;
            textAliases: string[];
            category?: string;
            args?: Array<{ choices?: Array<string | { value: string; label: string }> }>;
          }>;
        }
      | undefined;

    const acp = payload?.commands.find((command) => command.key === "acp");
    const subagents = payload?.commands.find((command) => command.key === "subagents");

    expect(acp?.textAliases).toContain("/acp");
    expect(acp?.category).toBe("management");
    expect(
      acp?.args?.[0]?.choices?.some((choice) =>
        typeof choice === "string" ? choice === "spawn" : choice.value === "spawn",
      ),
    ).toBe(true);

    expect(subagents?.textAliases).toContain("/subagents");
    expect(subagents?.category).toBe("management");
  });
});
