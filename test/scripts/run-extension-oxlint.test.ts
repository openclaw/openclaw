import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLintTargets } from "../../scripts/lib/run-extension-oxlint.mjs";

describe("resolveLintTargets", () => {
  it("keeps extension roots instead of expanding every file path", () => {
    const repoRoot = path.join("D:", "code", "openclaw", "openclaw");

    expect(
      resolveLintTargets(repoRoot, [
        "extensions/discord",
        path.join(repoRoot, "extensions", "slack"),
        "extensions/discord",
      ]),
    ).toEqual(["extensions/discord", "extensions/slack"]);
  });
});
