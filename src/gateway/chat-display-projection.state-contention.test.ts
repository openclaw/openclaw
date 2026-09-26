import { expect, it } from "vitest";
import { STATE_CONTENTION_DIAGNOSTIC } from "../sessions/session-run-error-presentation.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

it.each(["state_contention", "unknown", undefined])(
  "allowlists only certified presentation, never raw report diagnostics (%s)",
  (errorKind) => {
    const [result] = projectChatDisplayMessages([
      {
        role: "custom",
        customType: "run-failed-before-reply",
        content: "Public summary",
        details: {
          runId: "run-1",
          errorKind,
          error: "PRIVATE_ERROR_CANARY",
          diagnostic: "PRIVATE_DIAGNOSTIC_CANARY",
          path: "PRIVATE_PATH_CANARY",
        },
      },
    ]);
    expect(result).toMatchObject({ content: "Public summary", __openclaw: { runId: "run-1" } });
    if (errorKind === "state_contention") {
      expect(result).toHaveProperty("details", {
        errorKind,
        diagnostic: STATE_CONTENTION_DIAGNOSTIC,
      });
    } else {
      expect(result).not.toHaveProperty("details");
    }
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  },
);
