import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { SessionStoreRegistryReadRequired } from "./session-sqlite-target.js";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
  readSessionStoreTargetInventory,
} from "./session-store-target-inventory.js";
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from "./targets-read-availability.js";

vi.mock("./targets-read-availability.js", () => ({
  resolveExistingAgentSessionStoreTargetsReadOnlyResult: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
afterEach(() => resetConfigRuntimeState());

test("shares published config while recapturing candidates and following config publications", () => {
  const root = tempDirs.make("session-inventory-publication-");
  const env = { OPENCLAW_STATE_DIR: root };
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: { store: path.join(root, "custom.json") },
  };
  setRuntimeConfigSnapshot(cfg);
  const original = prepareSessionStoreTargetInventory(cfg, ["main"], env);
  const sibling = path.join(root, "custom.main.sqlite");
  fs.writeFileSync(sibling, "");
  const current = prepareSessionStoreTargetInventory(cfg, ["main"], env);
  expect(current.config).toBe(original.config);
  expect(Object.isFrozen(current.config.session)).toBe(true);
  expect(original.candidates.some((candidate) => candidate.path === sibling)).toBe(false);
  expect(current.candidates.some((candidate) => candidate.path === sibling)).toBe(true);

  cfg.session!.store = path.join(root, "replacement.json");
  setRuntimeConfigSnapshot(cfg);
  const replacement = prepareSessionStoreTargetInventory(cfg, ["main"], env);
  expect(replacement.config).not.toBe(original.config);
  expect(replacement.paths.get("main")?.configured).toBe(cfg.session!.store);
  expect(original.config.session?.store).toBe(path.join(root, "custom.json"));
});

test("isolates detached inventory configs across caller edits", () => {
  const root = tempDirs.make("session-inventory-detached-");
  const env = { OPENCLAW_STATE_DIR: root };
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: { store: path.join(root, "original.json") },
  };
  const original = prepareSessionStoreTargetInventory(cfg, ["main"], env);
  cfg.session!.store = path.join(root, "replacement.json");
  const replacement = prepareSessionStoreTargetInventory(cfg, ["main"], env);
  expect(original.config.session?.store).toBe(path.join(root, "original.json"));
  expect(replacement.paths.get("main")?.configured).toBe(cfg.session!.store);
});

test.each(["shared.sqlite", "agents/main/agent/openclaw-agent.sqlite"])(
  "captures an exact database once without sibling discovery: %s",
  (relativePath) => {
    const root = tempDirs.make("session-candidate-capture-");
    const databasePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "");
    const physicalPath = fs.realpathSync.native(databasePath);
    const resolve = vi.spyOn(fs.realpathSync, "native");
    expect(captureSessionStoreReadCandidates(databasePath)).toEqual([
      { path: databasePath, physicalPath },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  },
);

test("captures distinct sibling files and keeps family custody when discovery fails", () => {
  const root = tempDirs.make("session-candidate-family-");
  const databasePath = path.join(root, "custom.sqlite");
  const siblingPath = path.join(root, "custom.main.sqlite");
  fs.writeFileSync(databasePath, "");
  fs.writeFileSync(siblingPath, "");
  fs.writeFileSync(`${siblingPath}-wal`, "");
  const physicalRoot = fs.realpathSync.native(root);
  const expected = [
    {
      path: databasePath,
      physicalPath: path.join(physicalRoot, "custom.sqlite"),
      scope: "sibling-family",
    },
    { path: databasePath, physicalPath: path.join(physicalRoot, "custom.sqlite") },
  ];
  const storePath = path.join(root, "custom.json");
  expect(captureSessionStoreReadCandidates(storePath)).toEqual([
    ...expected,
    { path: siblingPath, physicalPath: path.join(physicalRoot, "custom.main.sqlite") },
  ]);
  const unavailable = path.join(root, "not-a-directory");
  fs.writeFileSync(unavailable, "");
  const failedPath = path.join(unavailable, "custom.sqlite");
  const failedPhysicalPath = path.join(physicalRoot, "not-a-directory", "custom.sqlite");
  expect(captureSessionStoreReadCandidates(path.join(unavailable, "custom.json"))).toEqual([
    { path: failedPath, physicalPath: failedPhysicalPath, scope: "sibling-family" },
    { path: failedPath, physicalPath: failedPhysicalPath },
  ]);
});

test.each(["read-failed", "schema-missing", "database-missing"] as const)(
  "carries prior %s cleanup requirements through registry deferral",
  (reason) => {
    vi.mocked(resolveExistingAgentSessionStoreTargetsReadOnlyResult)
      .mockReturnValueOnce({ available: false, reason })
      .mockImplementationOnce(() => {
        throw new SessionStoreRegistryReadRequired();
      });
    expect(
      readSessionStoreTargetInventory({
        config: {},
        agentIds: ["main", "other"],
        env: {},
        paths: new Map(),
        candidates: [],
        registeredDatabases: { status: "deferred" },
      }),
    ).toEqual({
      kind: "session-target-registry-required",
      readFailed: reason !== "database-missing",
    });
  },
);
