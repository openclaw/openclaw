import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareConfigRuntimeEnv } from "../config-env-vars.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { SessionStoreRegistryReadRequired } from "./session-sqlite-target.js";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
  readSessionStoreTargetInventory,
} from "./session-store-target-inventory.js";
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from "./targets-read-availability.worker.js";

// mock-isolation: Inventory cases supply availability without opening persistent stores.
vi.mock("./targets-read-availability.worker.js", () => ({
  resolveExistingAgentSessionStoreTargetsReadOnlyResult: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;
let cfg: OpenClawConfig;
beforeEach(() => {
  root = tempDirs.make("session-inventory-");
  env = { OPENCLAW_STATE_DIR: root };
  cfg = { agents: { entries: { main: {} } } };
});
const prepare = (inputEnv?: NodeJS.ProcessEnv) =>
  prepareSessionStoreTargetInventory(cfg, ["main"], inputEnv);
afterEach(() => vi.restoreAllMocks());
afterEach(() => resetConfigRuntimeState());
afterEach(() => vi.unstubAllEnvs());

test("discovers canonical recovery stores without waiting for the shared ownership registry", () => {
  cfg = { agents: { entries: { main: {}, helper: {} } } };
  const targets = ["main", "helper"].map((agentId) => {
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");
    return { agentId, storePath: path.join(sessionsDir, "sessions.json") };
  });
  const inventory = readSessionStoreTargetInventory({
    ...prepareSessionStoreTargetInventory(cfg, ["main", "helper"], env, "recovery"),
    registeredDatabases: { status: "deferred" },
  });
  expect(inventory.kind).toBe("session-target-inventory");
  if (inventory.kind === "session-target-inventory") {
    expect(
      inventory.agents.flatMap(({ result }) => (result.available ? result.targets : [])),
    ).toEqual(expect.arrayContaining(targets));
  }
});

test("shares published config while recapturing candidates and following config publications", () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  cfg.session = { store: path.join(root, "custom.json") };
  setRuntimeConfigSnapshot(cfg);
  const original = prepare();
  const sibling = path.join(root, "custom.main.sqlite");
  fs.writeFileSync(sibling, "");
  const current = prepare();
  expect(current.config).toBe(original.config);
  expect(current.env).toBe(original.env);
  expect(Object.isFrozen(current.env)).toBe(true);
  expect(Object.isFrozen(current.config.session)).toBe(true);
  expect(original.candidates.some((candidate) => candidate.path === sibling)).toBe(false);
  expect(current.candidates.some((candidate) => candidate.path === sibling)).toBe(true);

  cfg.session!.store = path.join(root, "replacement.json");
  setRuntimeConfigSnapshot(cfg);
  const replacement = prepare();
  expect(replacement.config).not.toBe(original.config);
  expect(replacement.env).not.toBe(original.env);
  expect(replacement.paths.get("main")?.configured).toBe(cfg.session!.store);
  expect(original.config.session?.store).toBe(path.join(root, "custom.json"));
});

test("refreshes published inventory environments after env publication and rollback", () => {
  const key = "OPENCLAW_TEST_INVENTORY_ENV";
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv(key, undefined);
  setRuntimeConfigSnapshot(cfg);
  const original = prepare();
  const publication = prepareConfigRuntimeEnv({
    previousConfig: cfg,
    nextConfig: { ...cfg, env: { vars: { [key]: "published" } } },
  }).publish();
  try {
    const current = prepare();
    expect(current.env[key]).toBe("published");
    expect(original.env[key]).toBeUndefined();
    expect(prepare().env).toBe(current.env);
  } finally {
    publication();
  }
  const restored = prepare();
  expect(restored.env[key]).toBeUndefined();
  expect(prepare().env).toBe(restored.env);
});

test("isolates detached inventory configs and explicit environments across caller edits", () => {
  cfg.session = { store: path.join(root, "original.json") };
  const original = prepare(env);
  cfg.session!.store = path.join(root, "replacement.json");
  env.OPENCLAW_STATE_DIR = path.join(root, "replacement-state");
  const replacement = prepare(env);
  expect(original.config.session?.store).toBe(path.join(root, "original.json"));
  expect(replacement.paths.get("main")?.configured).toBe(cfg.session!.store);
  expect(original.env.OPENCLAW_STATE_DIR).toBe(root);
  expect(replacement.env.OPENCLAW_STATE_DIR).toBe(path.join(root, "replacement-state"));
});

test("captures explicit environments afresh even for the active config", () => {
  setRuntimeConfigSnapshot(cfg);
  const original = prepare(env);
  env.OPENCLAW_STATE_DIR = path.join(root, "replacement");
  const replacement = prepare(env);
  expect(original.env.OPENCLAW_STATE_DIR).toBe(root);
  expect(replacement.env.OPENCLAW_STATE_DIR).toBe(path.join(root, "replacement"));
  expect(replacement.paths.get("main")?.default).toBe(
    path.join(root, "replacement", "agents", "main", "sessions", "sessions.json"),
  );
});

test.each(["shared.sqlite", "agents/main/agent/openclaw-agent.sqlite"])(
  "captures an exact database once without sibling discovery: %s",
  (relativePath) => {
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
  const databasePath = path.join(root, "custom.sqlite");
  const siblingPath = path.join(root, "custom.main.sqlite");
  fs.writeFileSync(databasePath, "");
  fs.writeFileSync(siblingPath, "");
  fs.writeFileSync(`${siblingPath}-wal`, "");
  const physicalRoot = fs.realpathSync.native(root);
  const candidate = (pathname: string, physicalPath: string) => ({ path: pathname, physicalPath });
  const base = candidate(databasePath, path.join(physicalRoot, "custom.sqlite"));
  const expected = [{ ...base, scope: "sibling-family" }, base];
  const storePath = path.join(root, "custom.json");
  expect(captureSessionStoreReadCandidates(storePath)).toEqual([
    ...expected,
    candidate(siblingPath, path.join(physicalRoot, "custom.main.sqlite")),
  ]);
  const unavailable = path.join(root, "not-a-directory");
  fs.writeFileSync(unavailable, "");
  const failedPath = path.join(unavailable, "custom.sqlite");
  const failedPhysicalPath = path.join(physicalRoot, "not-a-directory", "custom.sqlite");
  expect(captureSessionStoreReadCandidates(path.join(unavailable, "custom.json"))).toEqual([
    { ...candidate(failedPath, failedPhysicalPath), scope: "sibling-family" },
    candidate(failedPath, failedPhysicalPath),
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
