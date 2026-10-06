import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

vi.hoisted(() => {
  // The custody runner can preload these owners before the Windows path mock.
  vi.resetModules();
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => {
  mockProcessPlatform("win32");
  // These locators are synthetic; canonical-root cases supply their own observed root.
  vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync").mockImplementation(
    (root) => root,
  );
});
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

  it.each([
    {
      stateDir: String.raw`\\kost\share\OpenClaw`,
      canonicalRoot: String.raw`\\kost\share\OpenClaw`,
      agentPath: String.raw`\\Kost\share\OpenClaw\agents\main\agent.sqlite`,
    },
    {
      stateDir: String.raw`\\server\share\OpenClaw`,
      canonicalRoot: String.raw`\\server\share\OpenClaw`,
      agentPath: String.raw`\\?\UNC\server\share\..\..\server\share\OpenClaw\agent.sqlite`,
    },
    {
      stateDir: String.raw`C:\OpenClaw`,
      canonicalRoot: String.raw`C:\OpenClaw`,
      agentPath: String.raw`\\.\C:\..\UNC\server\share\agent.sqlite`,
    },
    {
      stateDir: String.raw`C:\Alias`,
      canonicalRoot: String.raw`\\kost\share\OpenClaw`,
      agentPath: String.raw`\\Kost\share\OpenClaw\agents\main\agent.sqlite`,
    },
    {
      stateDir: String.raw`C:\Alias`,
      canonicalRoot: String.raw`\\server\share\OpenClaw`,
      agentPath: String.raw`\\?\UNC\server\share\..\..\server\share\OpenClaw\agent.sqlite`,
    },
  ])(
    "retains raw locator identity for $agentPath under $stateDir",
    ({ stateDir, canonicalRoot, agentPath }) => {
      vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync").mockImplementation(
        (root) => {
          expect(root, "only the trusted state root may be probed").toBe(stateDir);
          return canonicalRoot;
        },
      );
      const registry = path.join(stateDir, "state", "openclaw.sqlite");
      const stored = resolveOpenClawAgentDatabaseStoredPath(registry, agentPath);
      expect(stored).toBe(agentPath);
      expect(resolveOpenClawRegisteredAgentDatabasePath(registry, stored)).toBe(agentPath);
    },
  );

  it.each([
    { canonicalRoot: String.raw`D:\Canonical`, relative: String.raw`agents\main\agent.sqlite` },
    {
      canonicalRoot: String.raw`\\server\share\Canonical`,
      relative: String.raw`agents\main\agent.sqlite`,
    },
    { canonicalRoot: String.raw`D:\Canonical`, relative: String.raw`linked\..\agent.sqlite` },
  ])(
    "relativizes an admitted $relative under canonical root $canonicalRoot",
    ({ canonicalRoot, relative }) => {
      const registry = String.raw`C:\Alias\state\openclaw.sqlite`;
      const resolveRoot = vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync");
      for (const root of [canonicalRoot, path.toNamespacedPath(canonicalRoot)]) {
        resolveRoot.mockReturnValue(root);
        for (const sourceRoot of [canonicalRoot, path.toNamespacedPath(canonicalRoot)]) {
          const candidate = `${sourceRoot}\\${relative}`;
          expect(resolveOpenClawAgentDatabaseStoredPath(registry, candidate)).toBe(relative);
        }
      }
    },
  );

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
