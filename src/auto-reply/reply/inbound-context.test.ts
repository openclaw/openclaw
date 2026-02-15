import { describe, expect, it } from "vitest";
import { finalizeInboundContext } from "./inbound-context.js";

describe("finalizeInboundContext", () => {
  it("strips leaked protocol lines from inbound bodies", () => {
    const leaked = [
      "user to=functions.session_status commentary accidental againjson {}",
      "assistant to=final code NO_REPLY",
      "",
      "Please fix this.",
    ].join("\n");

    const result = finalizeInboundContext({
      Body: leaked,
      RawBody: leaked,
      CommandBody: leaked,
      CommandAuthorized: true,
    });

    expect(result.Body).toBe("Please fix this.");
    expect(result.BodyForAgent).toBe("Please fix this.");
    expect(result.BodyForCommands).toBe("Please fix this.");
    expect(result.RawBody).toBe("Please fix this.");
    expect(result.CommandBody).toBe("Please fix this.");
  });
});
