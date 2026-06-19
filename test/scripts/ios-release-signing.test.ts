// iOS release signing tests cover checked-in Fastlane-managed profile pinning.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-release-signing.mjs");

function runSigning(mode: string): string {
  return execFileSync(process.execPath, [SCRIPT, "--mode", mode], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/ios-release-signing.mjs", () => {
  it("emits manual App Store profile settings for every signed target", () => {
    const output = runSigning("xcconfig");

    expect(output).toContain("OPENCLAW_CODE_SIGN_STYLE = Manual");
    expect(output).toContain("OPENCLAW_CODE_SIGN_IDENTITY = Apple Distribution");
    expect(output).toContain("OPENCLAW_APP_PROFILE = OpenClaw App Store ai.openclawfoundation.app");
    expect(output).toContain(
      "OPENCLAW_SHARE_PROFILE = OpenClaw App Store ai.openclawfoundation.app.share",
    );
    expect(output).toContain(
      "OPENCLAW_ACTIVITY_WIDGET_PROFILE = OpenClaw App Store ai.openclawfoundation.app.activitywidget",
    );
    expect(output).toContain(
      "OPENCLAW_WATCH_APP_PROFILE = OpenClaw App Store ai.openclawfoundation.app.watchkitapp",
    );
    expect(output).not.toContain("OPENCLAW_WATCH_EXTENSION_PROFILE");
  });

  it("documents the canonical release signing plan", () => {
    const output = runSigning("plan");

    expect(output).toContain("Team ID: FWJYW4S8P8");
    expect(output).toContain("Signing repo: git@github.com:openclaw/apps-signing.git");
    expect(output).toContain("Signing branch: main");
    expect(output).toContain("Signing setup and sync: Fastlane match");
    expect(output).not.toContain("OpenClawWatchExtension");
    expect(output).toContain("capabilities: PUSH_NOTIFICATIONS");
  });
});
