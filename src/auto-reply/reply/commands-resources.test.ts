import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import { parseInlineDirectives } from "./directive-handling.js";
import { handleResourcesCommand } from "./commands-resources.js";

vi.mock("../../infra/system-resources.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/system-resources.js")>(
    "../../infra/system-resources.js",
  );
  return {
    ...actual,
    readResourceSnapshot: vi.fn(async ({ scope, includeTop }) => {
      if (scope === "host") {
        return {
          scope,
          cpu: { usagePct: 10, loadAvg: [0.1, 0.05, 0.01], cores: 8 },
          memory: { totalBytes: 16_000, usedBytes: 4_000, availableBytes: 12_000 },
          disk: { path: "/host", totalBytes: 100_000, usedBytes: 20_000, freeBytes: 80_000, availableBytes: 80_000 },
          topProcesses: includeTop
            ? [
                { pid: 123, command: "node", cpuPct: 12.3, memPct: 3.4 },
                { pid: 456, command: "nginx", cpuPct: 5.1, memPct: 1.2 },
              ]
            : undefined,
        };
      }
      return {
        scope,
        cpu: { usagePct: 25, loadAvg: [0.2, 0.1, 0.05], cores: 4 },
        memory: { totalBytes: 8_000, usedBytes: 2_000, availableBytes: 6_000 },
        disk: { path: "/", totalBytes: 50_000, usedBytes: 10_000, freeBytes: 40_000, availableBytes: 40_000 },
        topProcesses: includeTop ? [{ pid: 789, command: "python", cpuPct: 22.2, memPct: 4.4 }] : undefined,
      };
    }),
  };
});

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-resources-"));
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, { recursive: true, force: true });
});

function buildParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: testWorkspaceDir,
    defaultGroupActivation: () => "mention" as const,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleResourcesCommand", () => {
  it("returns container resources by default", async () => {
    const cfg = { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } } as OpenClawConfig;
    const params = buildParams("/resources", cfg);
    const result = await handleResourcesCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Resources");
    expect(result?.reply?.text).toContain("CPU:");
    expect(result?.reply?.text).toContain("Memory:");
    expect(result?.reply?.text).toContain("Disk");
  });

  it("returns host resources when requested", async () => {
    const cfg = { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } } as OpenClawConfig;
    const params = buildParams("/resources host", cfg);
    const result = await handleResourcesCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Host:");
    expect(result?.reply?.text).toContain("CPU:");
  });

  it("includes top processes when requested", async () => {
    const cfg = { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } } as OpenClawConfig;
    const params = buildParams("/resources top", cfg);
    const result = await handleResourcesCommand(params, true);
    expect(result?.reply?.text).toContain("Top processes:");
  });

  it("ignores unauthorized senders", async () => {
    const cfg = { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } } as OpenClawConfig;
    const params = buildParams("/resources", cfg, { CommandAuthorized: false });
    params.command.isAuthorizedSender = false;
    const result = await handleResourcesCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
  });
});
