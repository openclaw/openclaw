import {
  importLegacyCommitmentStoreFileToSqlite,
  legacyCommitmentStoreFileExists,
} from "../commitments/store.js";
import { resolveStateDir } from "../config/paths.js";
import {
  importLegacyDeviceAuthFileToSqlite,
  legacyDeviceAuthFileExists,
} from "../infra/device-auth-store.js";
import {
  importLegacyDeviceBootstrapFileToSqlite,
  legacyDeviceBootstrapFileExists,
} from "../infra/device-bootstrap.js";
import {
  importLegacyDeviceIdentityFileToSqlite,
  legacyDeviceIdentityFileExists,
} from "../infra/device-identity.js";
import type { DevicePairingPendingRequest, PairedDevice } from "../infra/device-pairing.js";
import type { NodePairingPairedNode, NodePairingPendingRequest } from "../infra/node-pairing.js";
import {
  importLegacyPairingStateFilesToSqlite,
  legacyPairingStateFilesExist,
} from "../infra/pairing-files.js";
import {
  importLegacyApnsRegistrationFileToSqlite,
  legacyApnsRegistrationFileExists,
} from "../infra/push-apns.js";
import { importLegacyWebPushFilesToSqlite, legacyWebPushFilesExist } from "../infra/push-web.js";
import {
  importLegacyChannelPairingFilesToSqlite,
  legacyChannelPairingFilesExist,
} from "../pairing/pairing-store.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type LegacyStateProbe = {
  deviceIdentity: boolean;
  deviceAuth: boolean;
  deviceBootstrap: boolean;
  devicePairing: boolean;
  nodePairing: boolean;
  channelPairing: boolean;
  commitments: boolean;
  webPush: boolean;
  apns: boolean;
};

async function probeLegacyRuntimeStateFiles(env: NodeJS.ProcessEnv): Promise<LegacyStateProbe> {
  const baseDir = resolveStateDir(env);
  return {
    deviceIdentity: legacyDeviceIdentityFileExists(env),
    deviceAuth: legacyDeviceAuthFileExists(env),
    deviceBootstrap: await legacyDeviceBootstrapFileExists(baseDir),
    devicePairing: await legacyPairingStateFilesExist({ baseDir, subdir: "devices" }),
    nodePairing: await legacyPairingStateFilesExist({ baseDir, subdir: "nodes" }),
    channelPairing: await legacyChannelPairingFilesExist(env),
    commitments: await legacyCommitmentStoreFileExists(env),
    webPush: await legacyWebPushFilesExist(baseDir),
    apns: await legacyApnsRegistrationFileExists(baseDir),
  };
}

function hasLegacyRuntimeStateFiles(probe: LegacyStateProbe): boolean {
  return Object.values(probe).some(Boolean);
}

export async function maybeRepairLegacyRuntimeStateFiles(params: {
  prompter: Pick<DoctorPrompter, "shouldRepair">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  const baseDir = resolveStateDir(env);
  const probe = await probeLegacyRuntimeStateFiles(env);
  if (!hasLegacyRuntimeStateFiles(probe)) {
    return;
  }
  if (!params.prompter.shouldRepair) {
    note(
      "Legacy runtime JSON state files detected. Run `openclaw doctor --fix` to import commitments, device, bootstrap, channel pairing, node pairing, and push state into SQLite.",
      "SQLite state",
    );
    return;
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const runImport = async (label: string, operation: () => Promise<void> | void) => {
    try {
      await operation();
    } catch (error) {
      warnings.push(`- ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (probe.deviceIdentity) {
    await runImport("Device identity", () => {
      const result = importLegacyDeviceIdentityFileToSqlite(env);
      if (result.imported) {
        changes.push("- Imported device identity into SQLite.");
      }
    });
  }
  if (probe.deviceAuth) {
    await runImport("Device auth", () => {
      const result = importLegacyDeviceAuthFileToSqlite(env);
      if (result.imported) {
        changes.push(`- Imported ${result.tokens} device auth token(s) into SQLite.`);
      }
    });
  }
  if (probe.deviceBootstrap) {
    await runImport("Device bootstrap", async () => {
      const result = await importLegacyDeviceBootstrapFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.tokens} device bootstrap token(s) into SQLite.`);
      }
    });
  }
  if (probe.devicePairing) {
    await runImport("Device pairing", async () => {
      const result = await importLegacyPairingStateFilesToSqlite<
        DevicePairingPendingRequest,
        PairedDevice
      >({ baseDir, subdir: "devices" });
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.pending} pending device pairing request(s) and ${result.paired} paired device record(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.nodePairing) {
    await runImport("Node pairing", async () => {
      const result = await importLegacyPairingStateFilesToSqlite<
        NodePairingPendingRequest,
        NodePairingPairedNode
      >({ baseDir, subdir: "nodes" });
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.pending} pending node pairing request(s) and ${result.paired} paired node record(s) into SQLite.`,
        );
      }
    });
  }
  if (probe.channelPairing) {
    await runImport("Channel pairing", async () => {
      const result = await importLegacyChannelPairingFilesToSqlite(env);
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.requests} channel pairing request(s) and ${result.allowFrom} channel allowlist entr${result.allowFrom === 1 ? "y" : "ies"} into SQLite.`,
        );
      }
    });
  }
  if (probe.commitments) {
    await runImport("Commitments", async () => {
      const result = await importLegacyCommitmentStoreFileToSqlite(env);
      if (result.imported) {
        changes.push(`- Imported ${result.commitments} commitment record(s) into SQLite.`);
      }
    });
  }
  if (probe.webPush) {
    await runImport("Web push", async () => {
      const result = await importLegacyWebPushFilesToSqlite(baseDir);
      if (result.files > 0) {
        changes.push(
          `- Imported ${result.subscriptions} web push subscription(s)${result.importedVapidKeys ? " and VAPID keys" : ""} into SQLite.`,
        );
      }
    });
  }
  if (probe.apns) {
    await runImport("APNs push", async () => {
      const result = await importLegacyApnsRegistrationFileToSqlite(baseDir);
      if (result.imported) {
        changes.push(`- Imported ${result.registrations} APNs registration(s) into SQLite.`);
      }
    });
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
}
