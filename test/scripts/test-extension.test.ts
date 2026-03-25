import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
  listChangedExtensionIds,
  partitionExtensionTestFiles,
  resolveExtensionTestPlan,
} from "../../scripts/test-extension.mjs";

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mjs");

function readPlan(args: string[], cwd = process.cwd()) {
  const stdout = execFileSync(process.execPath, [scriptPath, ...args, "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ReturnType<typeof resolveExtensionTestPlan>;
}

function runScript(args: string[], cwd = process.cwd()) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("scripts/test-extension.mjs", () => {
  it("resolves channel-root extensions onto the channel vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "slack", cwd: process.cwd() });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe("extensions/slack");
    expect(plan.config).toBe("vitest.channels.config.ts");
    expect(plan.testFiles.some((file) => file.startsWith("extensions/slack/"))).toBe(true);
  });

  it("splits channel monitor files into isolated runs", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "discord", cwd: process.cwd() });

    expect(plan.config).toBe("vitest.channels.config.ts");
    expect(plan.isolatedTestFiles).toContain("extensions/discord/src/monitor/provider.test.ts");
    expect(plan.sharedTestFiles).toContain("extensions/discord/src/channel.test.ts");
    expect(plan.sharedTestFiles).not.toContain("extensions/discord/src/monitor/provider.test.ts");
  });

  it("resolves provider extensions onto the extensions vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "firecrawl", cwd: process.cwd() });

    expect(plan.extensionId).toBe("firecrawl");
    expect(plan.config).toBe("vitest.extensions.config.ts");
    expect(plan.testFiles.some((file) => file.startsWith("extensions/firecrawl/"))).toBe(true);
  });

  it("applies exact isolated files for non-channel extensions", () => {
    const { isolatedTestFiles, sharedTestFiles } = partitionExtensionTestFiles({
      config: "vitest.extensions.config.ts",
      testFiles: [
        "extensions/firecrawl/src/firecrawl-scrape-tool.test.ts",
        "extensions/firecrawl/src/index.test.ts",
      ],
    });

    expect(isolatedTestFiles).toEqual(["extensions/firecrawl/src/firecrawl-scrape-tool.test.ts"]);
    expect(sharedTestFiles).toEqual(["extensions/firecrawl/src/index.test.ts"]);
  });

  it("includes paired src roots when they contain tests", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "line", cwd: process.cwd() });

    expect(plan.roots).toContain("extensions/line");
    expect(plan.config).toBe("vitest.extensions.config.ts");
    expect(plan.testFiles.some((file) => file.startsWith("extensions/line/"))).toBe(true);
  });

  it("infers the extension from the current working directory", () => {
    const cwd = path.join(process.cwd(), "extensions", "slack");
    const plan = readPlan([], cwd);

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe("extensions/slack");
  });

  it("maps changed paths back to extension ids", () => {
    const extensionIds = detectChangedExtensionIds([
      "extensions/slack/src/channel.ts",
      "src/line/message.test.ts",
      "extensions/firecrawl/package.json",
      "src/not-a-plugin/file.ts",
    ]);

    expect(extensionIds).toEqual(["firecrawl", "line", "slack"]);
  });

  it("lists available extension ids", () => {
    const extensionIds = listAvailableExtensionIds();

    expect(extensionIds).toContain("slack");
    expect(extensionIds).toContain("firecrawl");
    expect(extensionIds).toEqual(
      [...extensionIds].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("can fail safe to all extensions when the base revision is unavailable", () => {
    const extensionIds = listChangedExtensionIds({
      base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      unavailableBaseBehavior: "all",
    });

    expect(extensionIds).toEqual(listAvailableExtensionIds());
  });

  it("dry-run still reports a plan for extensions without tests", () => {
    const plan = readPlan(["copilot-proxy"]);

    expect(plan.extensionId).toBe("copilot-proxy");
    expect(plan.testFiles).toEqual([]);
  });

  it("treats extensions without tests as a no-op by default", () => {
    const stdout = runScript(["copilot-proxy"]);

    expect(stdout).toContain("No tests found for extensions/copilot-proxy.");
    expect(stdout).toContain("Skipping.");
  });
});
