import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveOpenClawAgentDatabaseStoredPath } from "./openclaw-state-db.paths.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => mockProcessPlatform("win32"));
afterEach(() => vi.restoreAllMocks());

describe("Windows agent database inventory paths", () => {
  it.each([String.raw`C:\OpenClaw`, String.raw`\\Server\Share\OpenClaw`])(
    "uses one relative registration across namespace spellings under %s",
    (stateDir) => {
      const relative = String.raw`agents\main\agent\openclaw-agent.sqlite`;
      const registry = path.join(stateDir, "state", "openclaw.sqlite");
      const agent = path.join(stateDir, relative);
      for (const registryPath of [registry, path.toNamespacedPath(registry)]) {
        for (const agentPath of [agent, path.toNamespacedPath(agent)]) {
          expect(resolveOpenClawAgentDatabaseStoredPath(registryPath, agentPath)).toBe(relative);
        }
      }
    },
  );

  it.each([
    [String.raw`C:\OpenClaw`, String.raw`C:\External\openclaw-agent.sqlite`],
    [String.raw`C:\OpenClaw`, String.raw`D:\External\openclaw-agent.sqlite`],
    [String.raw`\\Server\Share\OpenClaw`, String.raw`\\Server\Other\openclaw-agent.sqlite`],
  ])("preserves an external native locator outside %s", (stateDir, external) => {
    const registry = path.join(stateDir, "state", "openclaw.sqlite");
    const namespaced = path.toNamespacedPath(external);
    expect(resolveOpenClawAgentDatabaseStoredPath(registry, namespaced)).toBe(namespaced);
  });

  it("preserves a raw in-root suffix instead of collapsing link traversal", () => {
    const stateDir = String.raw`C:\OpenClaw`;
    const registry = path.join(stateDir, "state", "openclaw.sqlite");
    const suffix = String.raw`linked\..\openclaw-agent.sqlite`;
    expect(resolveOpenClawAgentDatabaseStoredPath(registry, `${stateDir}\\${suffix}`)).toBe(suffix);
    expect(resolveOpenClawAgentDatabaseStoredPath(registry, `\\\\?\\${stateDir}\\${suffix}`)).toBe(
      suffix,
    );
  });

  it("preserves a device namespace without a plain drive/share spelling", () => {
    const registry = String.raw`C:\OpenClaw\state\openclaw.sqlite`;
    const device = String.raw`\\?\Volume{00000000-0000-0000-0000-000000000001}\agent.sqlite`;
    expect(resolveOpenClawAgentDatabaseStoredPath(registry, device)).toBe(device);
  });
});
