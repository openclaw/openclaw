/** Tests command-turn context normalization and source/kind conversions. */
import { describe, expect, it } from "vitest";
import {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
  type CommandTurnContext,
  type CommandTurnContextInput,
} from "./command-turn-context.js";
import { isExplicitCommandTurnContext } from "./command-turn-detection.js";

const isExplicit = (input: CommandTurnContextInput) => isExplicitCommandTurnContext(input, {});
function normalTurn(body: string, visible = body): CommandTurnContextInput {
  return {
    CommandTurn: { kind: "normal", source: "message", authorized: false, body },
    CommandAuthorized: true,
    Body: visible,
    RawBody: visible,
    CommandBody: body,
  };
}
function targetSession(turn: CommandTurnContext, key: string) {
  return resolveCommandTurnTargetSessionKey({ CommandTurn: turn, CommandTargetSessionKey: key });
}

describe("resolveCommandTurnContext", () => {
  it("keeps normal message turns non-explicit even when command auth is true elsewhere", () => {
    const commandTurn = resolveCommandTurnContext({
      CommandAuthorized: true,
      CommandBody: "hello",
    });
    expect(commandTurn).toMatchObject({
      kind: "normal",
      source: "message",
      authorized: false,
    });
    expect(isExplicitCommandTurn(commandTurn)).toBe(false);
  });

  it("keeps an empty canonical command authoritative over stale aliases", () => {
    const input = {
      commandText: "",
      CommandBody: "/reset",
      CommandAuthorized: true,
    };

    expect(resolveCommandTurnContext(input)).toMatchObject({
      kind: "normal",
      body: "",
      commandName: undefined,
    });
    expect(isExplicit(input)).toBe(false);
  });

  it("treats authorized control command bodies as explicit without legacy source tags", () => {
    expect(isExplicit({ CommandAuthorized: true, CommandBody: "/reset" })).toBe(true);
    expect(isExplicit({ CommandAuthorized: true, CommandBody: "hey can you /status please" })).toBe(
      false,
    );
  });

  it("keeps structured normal command turns non-explicit", () => {
    expect(isExplicit(normalTurn("/think high through this", "through this"))).toBe(false);
  });

  it("uses cleaned command bodies for command-shaped structured normal turns", () => {
    expect(isExplicit(normalTurn("/reset", "/reset@openclaw"))).toBe(true);
  });

  it("normalizes bot-mentioned command bodies for structured normal turns", () => {
    expect(isExplicit({ ...normalTurn("/reset@openclaw"), BotUsername: "openclaw" })).toBe(true);
  });

  it("lets structured command turns override legacy command fields", () => {
    expect(
      resolveCommandTurnContext({
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: false,
          commandName: "status",
          body: "/status",
        },
        CommandSource: "native",
        CommandAuthorized: true,
      }),
    ).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: false,
      commandName: "status",
      body: "/status",
    });
  });

  it("rejects inconsistent structured command turn pairs", () => {
    expect(
      resolveCommandTurnContext({
        CommandTurn: {
          kind: "native",
          source: "message",
          authorized: true,
        },
        CommandSource: "text",
        CommandAuthorized: true,
        CommandBody: "/status",
      }),
    ).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
    });
  });

  it("exposes native/text helper predicates and target session resolution", () => {
    const nativeTurn = createCommandTurnContext("native", {
      authorized: true,
      body: "/stop",
    });
    const textTurn = createCommandTurnContext("text", {
      authorized: true,
      body: "/status",
    });

    expect(isNativeCommandTurn(nativeTurn)).toBe(true);
    expect(isAuthorizedTextSlashCommandTurn(textTurn)).toBe(true);
    expect(targetSession(nativeTurn, " target-session ")).toBe("target-session");
    expect(
      resolveCommandTurnTargetSessionKey({
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: " legacy-target ",
      }),
    ).toBe("legacy-target");
    expect(
      targetSession(
        createCommandTurnContext("text", {
          authorized: true,
          body: "/steer finish with a table",
          commandName: "steer",
        }),
        " active-direct-session ",
      ),
    ).toBe("active-direct-session");
    expect(targetSession(textTurn, "must-not-retarget-status")).toBeUndefined();
    expect(
      targetSession(
        createCommandTurnContext("text", {
          authorized: false,
          body: "/steer denied",
          commandName: "steer",
        }),
        "must-not-retarget-unauthorized",
      ),
    ).toBeUndefined();
    expect(isExplicitCommandTurn(undefined)).toBe(false);
  });
});
