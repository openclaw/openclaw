import { createHash, randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import {
  publishFileNoClobber,
  requireDirectorySync,
  syncDirectory,
} from "../infra/directory-durability.js";
import { collectErrorGraphCandidates, extractErrorCode, readErrorCauses } from "../infra/errors.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  certificatePublicKeyHash,
  isNativeRootEligible,
  readNativeDistrustedPublicKeys,
} from "./launchd-legacy-ca-native.js";
import { resolveGatewayStateDir } from "./paths.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  GatewayServiceAuthorityError,
} from "./service-update-authority.js";

const LEGACY_CA_PATH = "/etc/ssl/cert.pem";
// OpenBSD revision 1.22.2.1, byte-identical to Apple's observed sealed template.
// This is provenance of appended additions, not a current trusted-root inventory.
const STOCK_BYTES = 333483;
const STOCK_SHA256 = "9dae8d76e55cb08991f2b672d58999ea15560d910759c16b544f843bdffbb994";
// Verified incident SPKIs, including alternate certificates and cross-signs:
// https://emudhra.we-have-a-problem.com/ (October 2026 incident disclosure).
const INCIDENT_KEYS = new Set([
  "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
  "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
  "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
  "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
  "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
  "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
  "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
  "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
]);

function parseCertificates(pem: string, appended = false): X509Certificate[] {
  const blocks = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu),
  ];
  if (
    appended &&
    pem
      .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "")
      .replace(/^\s*#.*$/gmu, "")
      .trim()
  ) {
    throw new Error("Malformed appended certificate data");
  }
  return blocks.map(([block]) => new X509Certificate(block));
}

/** Best effort must never hide a lost writer or an uncontained native child. */
export function rethrowCaMigrationAuthorityError(error: unknown): void {
  if (hasCommandProcessCleanupError(error)) {
    throw error;
  }
  const authority = collectErrorGraphCandidates(error, readErrorCauses).find(
    (candidate) => candidate instanceof GatewayServiceAuthorityError,
  );
  if (authority) {
    throw authority;
  }
}

async function publishMaintainedBundle(params: {
  destination: string;
  contents: string;
  assertCurrent: () => void;
}): Promise<void> {
  const matchesExisting = async () => {
    try {
      const { buffer, stat } = await readRegularFile({ filePath: params.destination });
      if (buffer.toString("utf8") !== params.contents || (stat.mode & 0o777) !== 0o600) {
        throw Object.assign(
          new Error("Existing maintained CA destination conflicts with migration"),
          { code: "EEXIST" },
        );
      }
      // A previous exclusive publication may have created this complete file
      // before its directory sync failed. A retry must finish that boundary.
      params.assertCurrent();
      const handle = await fs.open(params.destination, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      params.assertCurrent();
      requireDirectorySync(
        await syncDirectory(path.dirname(params.destination)),
        "Maintained CA bundle directory",
      );
      params.assertCurrent();
      return true;
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  if (await matchesExisting()) {
    return;
  }
  params.assertCurrent();
  const directory = path.dirname(params.destination);
  const stagingName = `.migration-${randomUUID()}.pem`;
  const staging = path.join(directory, stagingName);
  try {
    // The existing private-store owner validates directory traversal and stages a
    // complete 0600 file. Exclusive publication never replaces an operator file.
    await privateFileStore(directory).writeText(stagingName, params.contents);
    const handle = await fs.open(staging, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    params.assertCurrent();
    try {
      await publishFileNoClobber(staging, params.destination, {
        strategy: "link-required",
        durability: "fail-closed",
      });
    } catch (error) {
      if (extractErrorCode(error) !== "EEXIST" || !(await matchesExisting())) {
        throw error;
      }
    }
    params.assertCurrent();
  } finally {
    await fs.unlink(staging).catch(() => undefined);
  }
}

/** Refine only CA environment at the shared native service-publication owner. */
export async function prepareLaunchAgentCaEnvironment(params: {
  env: GatewayServiceEnv;
  label: string;
  environment: GatewayServiceEnv | undefined;
  installedExtraCa: string | undefined;
  assertCurrent: () => void;
  warn: (message: string) => void;
}): Promise<GatewayServiceEnv> {
  const environment = { ...params.environment };
  const planned = environment.NODE_EXTRA_CA_CERTS?.trim();
  const installed = params.installedExtraCa?.trim();
  if (planned && planned !== LEGACY_CA_PATH) {
    return environment;
  }
  if (installed && installed !== LEGACY_CA_PATH) {
    environment.NODE_EXTRA_CA_CERTS = params.installedExtraCa;
    return environment;
  }
  if (planned === LEGACY_CA_PATH) {
    delete environment.NODE_EXTRA_CA_CERTS;
    environment.NODE_USE_SYSTEM_CA ??= "1";
  }
  if (installed !== LEGACY_CA_PATH) {
    return environment;
  }

  delete environment.NODE_EXTRA_CA_CERTS;
  environment.NODE_USE_SYSTEM_CA ??= "1";
  const destination = path.join(
    resolveGatewayStateDir(params.env),
    "service-ca",
    `${params.label}-operator-ca.pem`,
  );
  const recovery = `Keep legitimate operator roots in a distinct maintained PEM bundle, set NODE_EXTRA_CA_CERTS to its absolute path, and reinstall the service with openclaw gateway install --force (Gateway) or openclaw node install --force (node host). Future CA rotations belong in that maintained bundle, never ${LEGACY_CA_PATH}. Compromised keys remain rejected.`;
  let failureStage: "input" | "classification" | "native" | "publication" = "input";
  try {
    const source = await fs.readFile(LEGACY_CA_PATH);
    if (
      source.length < STOCK_BYTES ||
      createHash("sha256").update(source.subarray(0, STOCK_BYTES)).digest("hex") !== STOCK_SHA256
    ) {
      params.warn(
        `CA migration ambiguous: ${LEGACY_CA_PATH} does not retain the authenticated historical stock prefix. Its old trust override was retired; private connections may fail. ${recovery}`,
      );
      return environment;
    }
    const additions = parseCertificates(source.subarray(STOCK_BYTES).toString("utf8"), true);
    failureStage = "classification";
    const stockKeys = new Set(
      parseCertificates(source.subarray(0, STOCK_BYTES).toString("utf8")).map(
        certificatePublicKeyHash,
      ),
    );
    const candidates = new Map<string, X509Certificate>();
    let excluded = 0;
    let ambiguous = 0;
    for (const certificate of additions) {
      let key: string;
      try {
        key = certificatePublicKeyHash(certificate);
      } catch {
        ambiguous++;
        continue;
      }
      if (INCIDENT_KEYS.has(key) || stockKeys.has(key)) {
        excluded++;
        continue;
      }
      // Self-signature bounds the supported root layout; only the authenticated
      // unchanged prefix establishes that this was an operator addition.
      if (
        !certificate.ca ||
        certificate.subject !== certificate.issuer ||
        !certificate.verify(certificate.publicKey)
      ) {
        ambiguous++;
        continue;
      }
      candidates.set(key, certificate);
    }
    const roots: X509Certificate[] = [];
    if (candidates.size) {
      failureStage = "native";
      const denied = await readNativeDistrustedPublicKeys();
      for (const [key, certificate] of candidates) {
        if (denied.has(key)) {
          excluded++;
          continue;
        }
        if (!(await isNativeRootEligible(certificate))) {
          ambiguous++;
          continue;
        }
        roots.push(certificate);
      }
    }
    const exclusion = excluded
      ? ` ${excluded} stock, compromised, or explicitly distrusted key occurrence(s) excluded.`
      : "";
    if (!roots.length) {
      params.warn(
        ambiguous
          ? `CA migration ambiguous: no eligible operator roots could be migrated; ${ambiguous} addition(s) require manual review.${exclusion} The legacy override was retired; private connections may fail. ${recovery}`
          : `CA migration unnecessary: no eligible operator additions beyond the historical stock bundle.${exclusion} The legacy override was retired; macOS system trust is used.`,
      );
      return environment;
    }
    failureStage = "publication";
    await publishMaintainedBundle({
      destination,
      contents: roots.map((certificate) => `${certificate.toString().trim()}\n`).join(""),
      assertCurrent: () => {
        assertGatewayServiceUpdateCurrent();
        params.assertCurrent();
      },
    });
    environment.NODE_EXTRA_CA_CERTS = destination;
    params.warn(
      `CA certificates migrated once to ${destination} (${roots.length} operator root(s)).${exclusion} ${ambiguous ? `${ambiguous} ambiguous addition(s) were not migrated; dependent connections may fail. ` : ""}Future CA rotations belong in this maintained bundle; the original ${LEGACY_CA_PATH} is untouched and will not be synchronized.${ambiguous ? ` ${recovery}` : ""}`,
    );
    return environment;
  } catch (error) {
    rethrowCaMigrationAuthorityError(error);
    const code = extractErrorCode(error);
    const reason = code && /^[a-z0-9_-]+$/iu.test(code) ? ` (${code})` : "";
    const action =
      failureStage === "publication"
        ? `publishing ${destination} without replacing operator files`
        : failureStage === "native"
          ? "establishing macOS trust and explicit distrust"
          : failureStage === "classification"
            ? "establishing operator certificate and key eligibility"
            : `reading or parsing ${LEGACY_CA_PATH}`;
    params.warn(
      `CA migration ${failureStage === "native" || failureStage === "classification" ? "ambiguous" : "failed"} while ${action}${reason}. The obsolete override was retired; private connections may fail. Original input and conflicting operator files were preserved. ${recovery}`,
    );
    return environment;
  }
}
