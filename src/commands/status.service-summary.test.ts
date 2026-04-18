import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../daemon/service.js";
import type { GatewayServiceEnvArgs } from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { readServiceStatusSummary } from "./status.service-summary.js";

function createService(overrides: Partial<GatewayService>): GatewayService {
  return createMockGatewayService({
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    ...overrides,
  });
}

describe("readServiceStatusSummary", () => {
  it("marks OpenClaw-managed services as installed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({ programArguments: ["openclaw", "gateway", "run"] })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(true);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("enabled");
  });

  it("marks running unmanaged services as externally managed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(false);
    expect(summary.externallyManaged).toBe(true);
    expect(summary.loadedText).toBe("running (externally managed)");
  });

  it("keeps missing services as not installed when nothing is running", async () => {
    const summary = await readServiceStatusSummary(createService({}), "Daemon");

    expect(summary.installed).toBe(false);
    expect(summary.managedByOpenClaw).toBe(false);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("disabled");
  });

  it("passes command environment to runtime and loaded checks", async () => {
    const isLoaded = vi.fn(async ({ env }: GatewayServiceEnvArgs) => {
      return env?.OPENCLAW_GATEWAY_PORT === "18789";
    });
    const readRuntime = vi.fn(async (env?: NodeJS.ProcessEnv) => ({
      status: env?.OPENCLAW_GATEWAY_PORT === "18789" ? ("running" as const) : ("unknown" as const),
    }));

    const summary = await readServiceStatusSummary(
      createService({
        isLoaded,
        readCommand: vi.fn(async () => ({
          programArguments: ["openclaw", "gateway", "run", "--port", "18789"],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        })),
        readRuntime,
      }),
      "Daemon",
    );

    expect(isLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_GATEWAY_PORT: "18789",
        }),
      }),
    );
    expect(readRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_GATEWAY_PORT: "18789",
      }),
    );
    expect(summary.installed).toBe(true);
    expect(summary.loaded).toBe(true);
    expect(summary.runtime).toMatchObject({ status: "running" });
  });

  it("keeps checking later command candidates before falling back to cwd", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-service-root-"));
    const tempBinDir = path.join(tempRoot, "dist");
    fs.mkdirSync(tempBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
    );
    fs.writeFileSync(path.join(tempBinDir, "entry.js"), "export {};\n");

    try {
      const summary = await readServiceStatusSummary(
        createService({
          readCommand: vi.fn(async () => ({
            programArguments: [
              "/usr/bin/env",
              "NODE_ENV=production",
              path.join(tempBinDir, "entry.js"),
            ],
            workingDirectory: process.cwd(),
          })),
        }),
        "Daemon",
      );

      expect(summary.packageRoot).toBe(tempRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips env-style arguments before checking real path candidates", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-service-root-env-"));
    const tempBinDir = path.join(tempRoot, "dist");
    fs.mkdirSync(tempBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
    );
    fs.writeFileSync(path.join(tempBinDir, "entry.js"), "export {};\n");

    try {
      const summary = await readServiceStatusSummary(
        createService({
          readCommand: vi.fn(async () => ({
            programArguments: [
              "/usr/bin/env",
              `NODE_OPTIONS=--require=${path.join(tempRoot, "hooks", "register.js")}`,
              path.join(tempBinDir, "entry.js"),
            ],
            workingDirectory: process.cwd(),
          })),
        }),
        "Daemon",
      );

      expect(summary.packageRoot).toBe(tempRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative entrypoint candidates against the service working directory", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-service-root-relative-"));
    const tempBinDir = path.join(tempRoot, "dist");
    fs.mkdirSync(tempBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
    );
    fs.writeFileSync(path.join(tempBinDir, "entry.js"), "export {};\n");

    try {
      const summary = await readServiceStatusSummary(
        createService({
          readCommand: vi.fn(async () => ({
            programArguments: ["node", "dist/entry.js", "gateway"],
            workingDirectory: tempRoot,
          })),
        }),
        "Daemon",
      );

      expect(summary.packageRoot).toBe(tempRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
