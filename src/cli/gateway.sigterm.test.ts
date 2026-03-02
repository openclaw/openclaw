import { describe, it } from "vitest";

describe("gateway SIGTERM", () => {
  it.skip("covered by runGatewayLoop signal tests in src/cli/gateway-cli/run-loop.test.ts", () => {
    // Kept as a placeholder to document why the old child-process integration
    // case was retired: it duplicated run-loop signal coverage at high runtime cost.
  });
});
