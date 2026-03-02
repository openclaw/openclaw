import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { theme } from "../../terminal/theme.js";
import { renderGatewayServiceStartHints, resolveRuntimeStatusColor } from "./shared.js";

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!originalPlatform) {
    throw new Error("missing process.platform descriptor");
  }
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

describe("resolveRuntimeStatusColor", () => {
  it("maps known runtime states to expected theme colors", () => {
    expect(resolveRuntimeStatusColor("running")).toBe(theme.success);
    expect(resolveRuntimeStatusColor("stopped")).toBe(theme.error);
    expect(resolveRuntimeStatusColor("unknown")).toBe(theme.muted);
  });

  it("falls back to warning color for unexpected states", () => {
    expect(resolveRuntimeStatusColor("degraded")).toBe(theme.warn);
    expect(resolveRuntimeStatusColor(undefined)).toBe(theme.muted);
  });
});

describe("renderGatewayServiceStartHints", () => {
  it("prefers .nop launch agent plist when both .nop and default files exist", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-hints-"));
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    try {
      await fs.mkdir(launchAgentsDir, { recursive: true });
      await fs.writeFile(path.join(launchAgentsDir, "ai.openclaw.gateway.plist"), "");
      await fs.writeFile(path.join(launchAgentsDir, "ai.openclaw.gateway.nop.plist"), "");

      await withPlatform("darwin", async () => {
        const hints = renderGatewayServiceStartHints({ HOME: home });
        expect(hints.at(-1)).toBe(
          "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.nop.plist",
        );
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("falls back to default launch agent plist when .nop variant is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-hints-"));
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    try {
      await fs.mkdir(launchAgentsDir, { recursive: true });
      await fs.writeFile(path.join(launchAgentsDir, "ai.openclaw.gateway.plist"), "");

      await withPlatform("darwin", async () => {
        const hints = renderGatewayServiceStartHints({ HOME: home });
        expect(hints.at(-1)).toBe(
          "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist",
        );
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
