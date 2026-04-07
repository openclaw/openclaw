import { describe, expect, it } from "vitest";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
  formatInvalidConfigLogMessage,
} from "./io.invalid-config.js";

describe("config io invalid config formatting", () => {
  it("formats issue details with sanitized paths and messages", () => {
    const details = formatInvalidConfigDetails([
      {
        path: "gateway.port",
        message: 'Expected number\\nreceived "bad"',
      },
      {
        path: "",
        message: "root problem",
      },
    ]);

    expect(details).toContain("- gateway.port:");
    expect(details).toContain("Expected number");
    expect(details).toContain("received");
    expect(details).toContain("- <root>: root problem");
  });

  it("formats the logger message with the escaped newline separator", () => {
    expect(formatInvalidConfigLogMessage("/tmp/openclaw.json", "- gateway.port: bad")).toBe(
      "Invalid config at /tmp/openclaw.json:\\n- gateway.port: bad",
    );
  });

  it("creates INVALID_CONFIG errors with inline details", () => {
    const err = createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: bad") as Error & {
      code?: string;
      details?: string;
    };

    expect(err.message).toBe("Invalid config at /tmp/openclaw.json:\n- gateway.port: bad");
    expect(err.code).toBe("INVALID_CONFIG");
    expect(err.details).toBe("- gateway.port: bad");
  });
});
