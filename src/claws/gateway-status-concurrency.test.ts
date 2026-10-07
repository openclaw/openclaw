import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-reader.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readClawStatusForGateway } from "./gateway-status-worker.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";

const mocked = vi.hoisted(() => ({
  readInventory: vi.fn(),
  readPluginMetadata: vi.fn(),
  stateDir: "",
}));

vi.mock("./inventory-read.js", () => ({ readClawInventory: mocked.readInventory }));
vi.mock("../plugins/plugin-metadata-state-worker.js", () => ({
  readPluginMetadataStateRow: mocked.readPluginMetadata,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadWorkerContext: () => ({
    admission: {
      databasePath: `${mocked.stateDir}/state/openclaw.sqlite`,
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: mocked.stateDir },
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageName = "@openclaw/audit";
const integrity = `sha256:${"a".repeat(64)}`;
const packageRef: PersistedClawPackageRef = {
  schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
  agentId: "audit-agent",
  clawName: packageName,
  kind: "plugin",
  source: "clawhub",
  ref: packageName,
  version: "1.0.0",
  integrity,
  status: "complete",
  relationship: "managed",
  origin: "claw-introduced",
  independentOwner: false,
  installedAtMs: 1,
  updatedAtMs: 1,
};

function metadataRow(version: string) {
  return {
    value_json: JSON.stringify({
      index: {
        installRecords: {
          audit: {
            source: "clawhub",
            clawhubPackage: packageName,
            version,
            resolvedVersion: version,
            integrity,
          },
        },
      },
    }),
  };
}

beforeEach(() => {
  mocked.stateDir = tempDirs.make("openclaw-claw-status-concurrency-");
  mocked.readInventory.mockResolvedValue({
    installs: [],
    packages: [packageRef],
    workspaceFiles: [],
    mcpServers: [],
    cronJobs: [],
  });
  resetPluginCache();
});

afterEach(() => {
  vi.resetAllMocks();
  resetPluginCache();
});

describe("Gateway Claw status plugin reads", () => {
  it("observes an installed plugin change on the next status request", async () => {
    let version = "1.0.0";
    mocked.readPluginMetadata.mockImplementation(async () => metadataRow(version));

    const first = await readClawStatusForGateway({ config: {} });
    expect(first.records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "plugin", state: "present" })]),
    );

    version = "2.0.0";
    const second = await readClawStatusForGateway({ config: {} });
    expect(second.records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "plugin", state: "modified" })]),
    );
  });

  it("keeps a pending status read valid when plugin records are cleared for removal", async ({
    signal,
  }) => {
    const releaseRead = createDeferredCore<ReturnType<typeof metadataRow>>();
    const reading = createDeferredCore();
    mocked.readPluginMetadata.mockImplementation(() => {
      reading.resolve();
      return releaseRead.promise;
    });

    const status = readClawStatusForGateway({ config: {} });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          reading.promise,
          status,
          "Claw status settled before reading plugin metadata",
        ),
        signal,
      );
      clearLoadInstalledPluginIndexInstallRecordsCache();
    } finally {
      releaseRead.resolve(metadataRow("1.0.0"));
    }

    const result = await withinTest(status, signal);
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "plugin", state: "present" })]),
    );
  });

  it("lets concurrent status requests inspect the same installed plugin", async ({ signal }) => {
    const releaseRead = createDeferredCore<ReturnType<typeof metadataRow>>();
    const firstReading = createDeferredCore();
    const bothReading = createDeferredCore();
    let reads = 0;
    mocked.readPluginMetadata.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        firstReading.resolve();
      } else if (reads === 2) {
        bothReading.resolve();
      }
      return releaseRead.promise;
    });

    const first = readClawStatusForGateway({ config: {} });
    await withinTest(
      awaitGateBeforeSettlement(
        firstReading.promise,
        first,
        "The first Claw status request settled before reading plugin metadata",
      ),
      signal,
    );
    const second = readClawStatusForGateway({ config: {} });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          bothReading.promise,
          Promise.race([first, second]),
          "A Claw status request settled before both plugin reads started",
        ),
        signal,
      );
    } finally {
      releaseRead.resolve(metadataRow("1.0.0"));
    }

    const statuses = await withinTest(Promise.all([first, second]), signal);
    for (const status of statuses) {
      expect(status.records[0]?.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "plugin",
            id: "@openclaw/audit@1.0.0",
            state: "present",
          }),
        ]),
      );
    }
  });
});
