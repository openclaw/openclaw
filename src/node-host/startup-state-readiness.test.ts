import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientCredentialMigrationRequiredError } from "../infra/client-credential-readiness.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import * as identityStore from "../infra/device-identity.js";
import {
  ExecApprovalsMigrationRequiredError,
  resetExecApprovalsMigrationGateForTest,
} from "../infra/exec-approvals-migration-gate.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";

const fixture = vi.hoisted(() => ({
  admitted: new Error("node runtime preparation reached"),
  configure: vi.fn(async () => ({ version: 1, nodeId: "test-node" })),
  prepare: vi.fn(),
  initializeSqlite: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));

vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  initializeSqliteRuntimeCapabilities: fixture.initializeSqlite,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("./config.js", () => ({
  loadNodeHostConfig: async () => null,
  configureNodeHost: fixture.configure,
}));
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "test-node" }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));

import { runNodeHost } from "./runner.js";
import { runNodeHostWorker } from "./worker.js";

const makeIdentity = () => generateStoredDeviceIdentity(1_700_000_000_000);

const entrypoints = [
  { name: "node runner", run: () => runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 }) },
  { name: "JSONL worker", run: runNodeHostWorker },
];
const run = entrypoints[0]!.run;

describe("node-host state readiness", () => {
  const tempDirs = useStateDatabaseTempDirs();
  afterEach(async () => {
    await stateDb.closeOpenClawStateDatabaseAsync();
    resetExecApprovalsMigrationGateForTest();
    vi.unstubAllEnvs();
  });

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const databasePath = () => path.join(stateDir, "state", "openclaw.sqlite");
  const identity = () => identityStore.loadDeviceIdentityIfPresent({ env });
  const expectAdmission = (start = run) => expect(start()).rejects.toBe(fixture.admitted);
  const expectUnprepared = () => {
    expect(fixture.configure).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.prepare.mockRejectedValue(fixture.admitted);
    fixture.initializeSqlite.mockReset().mockResolvedValue();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stateDir = fs.realpathSync(tempDirs.make("openclaw-node-readiness-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  function writeSource(relativePath: string, contents: unknown) {
    const sourcePath = path.join(stateDir, relativePath);
    const raw = `${JSON.stringify(contents)}\n`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, raw);
    return { sourcePath, raw };
  }

  it.each(entrypoints)(
    "$name awaits SQLite admission without creating identity or exec authority",
    async ({ run: start }) => {
      const entered = createDeferredCore();
      const decided = createDeferredCore();
      fixture.initializeSqlite.mockImplementationOnce(() => {
        entered.resolve();
        return decided.promise;
      });
      const starting = start();
      const outcome = expect(starting).rejects.toBe(fixture.admitted);
      try {
        await Promise.race([entered.promise, starting]);
        expect(fs.existsSync(databasePath())).toBe(false);
        expectUnprepared();
      } finally {
        decided.resolve();
        await outcome;
      }
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(identity()).toBeNull();
      expect(fs.existsSync(databasePath())).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
    },
  );

  it.each([
    "identity/device.json",
    "identity/device.json.doctor-importing",
    "identity/device.json.native-importing",
    "exec-approvals.json.doctor-importing",
  ])(
    "prepares valid %s before capabilities and preserves invalid sources",
    async (relativePath) => {
      const device = relativePath === "identity/device.json";
      const contents = device ? { version: 1, ...makeIdentity() } : { pending: true };
      const { sourcePath, raw } = writeSource(relativePath, contents);
      const start = device ? runNodeHostWorker : run;
      if (!device) {
        await expect(start()).rejects.toThrow(
          relativePath === "exec-approvals.json.doctor-importing"
            ? ExecApprovalsMigrationRequiredError
            : ClientCredentialMigrationRequiredError,
        );
        expect(fs.readFileSync(sourcePath)).toEqual(Buffer.from(raw));
        expect(fs.existsSync(databasePath())).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
        expectUnprepared();
        return;
      }
      await expectAdmission(start);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(contents).toMatchObject({ deviceId: identity()?.deviceId });
    },
  );

  it("refuses malformed selected Gateway state without replacing it", async () => {
    const selectedPath = databasePath();
    fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
    fs.writeFileSync(selectedPath, "synthetic selected Gateway state sentinel");
    await expect(run()).rejects.toThrow();
    expect(fs.readFileSync(selectedPath, "utf8")).toBe("synthetic selected Gateway state sentinel");
    expectUnprepared();
    expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
  });
});
