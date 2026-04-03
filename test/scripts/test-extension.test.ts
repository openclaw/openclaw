import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
  listChangedExtensionIds,
  resolveExtensionTestPlan,
} from "../../scripts/test-extension.mjs";
import { bundledPluginFile, bundledPluginRoot } from "../helpers/bundled-plugin-paths.js";

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

function findExtensionWithoutTests() {
  const extensionId = listAvailableExtensionIds().find(
    (candidate) => !resolveExtensionTestPlan({ targetArg: candidate, cwd: process.cwd() }).hasTests,
  );

  expect(extensionId).toBeDefined();
  return extensionId ?? "missing-no-test-extension";
}

describe("scripts/test-extension.mjs", () => {
  it("resolves channel-root extensions onto the channel vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "slack", cwd: process.cwd() });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
    expect(plan.config).toBe("vitest.channels.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("slack"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves provider extensions onto the extensions vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "firecrawl", cwd: process.cwd() });

    expect(plan.extensionId).toBe("firecrawl");
    expect(plan.config).toBe("vitest.extensions.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("firecrawl"));
    expect(plan.hasTests).toBe(true);
  });

  it("keeps extension-root plans lean when there is no paired core test root", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "line", cwd: process.cwd() });

    expect(plan.roots).toContain(bundledPluginRoot("line"));
    expect(plan.roots).not.toContain("src/line");
    expect(plan.config).toBe("vitest.extensions.config.ts");
    expect(plan.hasTests).toBe(true);
  });

  it("infers the extension from the current working directory", () => {
    const cwd = path.join(process.cwd(), "extensions", "slack");
    const plan = readPlan([], cwd);

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
  });

  it("maps changed paths back to extension ids", () => {
    const extensionIds = detectChangedExtensionIds([
      bundledPluginFile("slack", "src/channel.ts"),
      "src/line/message.test.ts",
      bundledPluginFile("firecrawl", "package.json"),
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
    const extensionId = findExtensionWithoutTests();
    const plan = readPlan([extensionId]);

    expect(plan.extensionId).toBe(extensionId);
    expect(plan.hasTests).toBe(false);
    expect(plan.testFileCount).toBe(0);
  });

  it("treats extensions without tests as a no-op by default", () => {
    const extensionId = findExtensionWithoutTests();
    const stdout = runScript([extensionId]);

    expect(stdout).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
    expect(stdout).toContain("Skipping.");
  });
});
