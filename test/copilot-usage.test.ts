import path from "node:path";
import { describe, expect, it } from "vitest";

import { scanCopilotUsage } from "../tools/copilot-enforcement/check-copilot-usage";

describe("Copilot SDK usage", () => {
  it("allows only @github/copilot-sdk", async () => {
    const repoRoot = path.resolve(process.cwd());
    const findings = await scanCopilotUsage(repoRoot);

    expect(findings).toEqual([]);
  });
});
