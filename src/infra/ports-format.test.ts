import { describe, expect, it } from "vitest";
import { classifyPortListener } from "./ports-format.js";

describe("classifyPortListener", () => {
  it("only classifies parsed OpenClaw gateway invocations as gateway", () => {
    expect(
      classifyPortListener(
        {
          commandLine:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789',
          command: "node.exe",
        },
        18789,
      ),
    ).toBe("gateway");
  });

  it("does not classify uncertain OpenClaw-related listeners as gateway", () => {
    expect(
      classifyPortListener(
        {
          commandLine: '"C:\\tools\\helper.exe" --label openclaw --port 18789',
          command: "helper.exe",
        },
        18789,
      ),
    ).toBe("unknown");

    expect(
      classifyPortListener(
        {
          command: "node.exe",
        },
        18789,
      ),
    ).toBe("unknown");
  });

  it("accepts a direct OpenClaw gateway executable path", () => {
    expect(
      classifyPortListener(
        {
          command: "C:\\Program Files\\OpenClaw\\openclaw-gateway.exe",
        },
        18789,
      ),
    ).toBe("gateway");
  });
});
