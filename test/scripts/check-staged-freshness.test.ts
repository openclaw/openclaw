import { describe, expect, it } from "vitest";
import { selectStagedFreshnessChecks } from "../../scripts/pre-commit/check-staged-freshness.mts";

const scripts = (paths: string[]) => selectStagedFreshnessChecks(paths).map(({ script }) => script);

describe("selectStagedFreshnessChecks", () => {
  it.each([
    [["docs/install/docker.md"], "lint:docs"],
    [["packages/gateway-protocol/src/schema/logs-chat.ts"], "protocol:check"],
    [
      ["apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt"],
      "native:i18n:verify",
    ],
    [["extensions/x/openclaw.plugin.json"], "config:docs:check"],
    [["extensions/feishu/src/bot.test.ts"], "check:line-cap-ratchet"],
    [["src/gateway/AGENTS.md"], "check:agents-md-size"],
  ])("selects the CI-owned check for %j", (paths, script) => {
    expect(scripts(paths)).toContain(script);
  });

  it("adds no work for paths no freshness check owns", () => {
    expect(scripts(["CHANGELOG.md", "docs/missing-page.md", ".github/CODEOWNERS"])).toEqual([]);
  });
});
