import { describe, expect, it } from "vitest";
import { buildBuiltinChatCommands } from "./commands-registry.shared.js";

describe("buildBuiltinChatCommands", () => {
  it("includes the /jenni text command", () => {
    const commands = buildBuiltinChatCommands();
    expect(commands).toContainEqual(
      expect.objectContaining({
        key: "jenni",
        textAliases: ["/jenni"],
        scope: "text",
        category: "tools",
      }),
    );
  });

  it("includes the /plans command", () => {
    const commands = buildBuiltinChatCommands();
    expect(commands).toContainEqual(
      expect.objectContaining({
        key: "plans",
        nativeName: "plans",
        textAliases: ["/plans"],
        acceptsArgs: true,
        category: "status",
      }),
    );
  });
});
