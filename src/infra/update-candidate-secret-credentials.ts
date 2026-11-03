import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { ignoreMissingPath as ignoreMissingUpdateCandidateSecretFile } from "./errno.js";

/**
 * State-relative credential root shared by exec SecretRef providers. The bundled
 * 1Password resolver reads `<state dir>/credentials/onepassword/service-account-token`,
 * keyed by its plugin identity, not by the operator-chosen config alias.
 */
const CREDENTIALS_DIRECTORY = "credentials";
/** Provider prerequisites are small key material files, never databases or media. */
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_FILES = 64;
const MAX_CREDENTIAL_DEPTH = 4;
/** Bounded scan work inside owned directories; exceeding it never fails the update. */
const MAX_SCANNED_DIRECTORIES = 64;
const MAX_SCANNED_ENTRIES_PER_DIRECTORY = 4096;
/** Provider identities name one directory inside the credential root, never a path. */
const CREDENTIAL_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

type SourceConfig = { secrets?: { providers?: Record<string, SecretProviderConfig> } };

/**
 * Name the state-relative credential directory a provider actually owns.
 *
 * Only a plugin-integration resolver locates material by plugin identity
 * (`credentials/<pluginId>`), so the plugin id — never the operator-chosen config
 * alias — is the ownership signal. `integrationId` is a key inside that plugin's manifest
 * (`secretProviderIntegrations[integrationId]`), not an independent credential owner, so
 * it must not select a directory: `pluginId: "onepassword"` with `integrationId: "slack"`
 * would otherwise copy `credentials/slack/oauth.json` before any consumer validated the
 * integration. A manual exec resolver runs an arbitrary command whose prerequisite cannot
 * be derived from config, so it projects nothing; treating its alias as ownership would
 * drag an unrelated plugin's secret into the rehearsal.
 */
function providerCredentialDirectory(provider: SecretProviderConfig): string | undefined {
  if (provider.source !== "exec" || !("pluginIntegration" in provider)) {
    return undefined;
  }
  const { pluginId } = provider.pluginIntegration;
  return typeof pluginId === "string" && CREDENTIAL_DIRECTORY_NAME.test(pluginId)
    ? pluginId
    : undefined;
}

/**
 * Select the credential files one owned directory holds, shallowest level first.
 *
 * The resolver's own prerequisite is the key material directly inside its credential
 * directory, so selection never depends on a whole-tree inventory: unrelated bulk nested
 * below it can neither crowd out the prerequisite nor turn a working serving installation
 * into a blocked update. Entries are visited in name order for a deterministic copy set,
 * and anything that is not a regular file or a directory (symlink, socket, fifo) is
 * neither selected nor followed.
 */
async function selectOwnedCredentialFiles(directory: string): Promise<string[]> {
  const selected: string[] = [];
  let level: { directory: string; depth: number }[] = [{ directory, depth: 1 }];
  let scannedDirectories = 0;
  while (level.length > 0 && selected.length < MAX_CREDENTIAL_FILES) {
    const nextLevel: typeof level = [];
    for (const current of level) {
      if (
        selected.length >= MAX_CREDENTIAL_FILES ||
        scannedDirectories >= MAX_SCANNED_DIRECTORIES
      ) {
        break;
      }
      scannedDirectories += 1;
      let handle;
      try {
        handle = await fs.opendir(current.directory);
      } catch (error) {
        // A directory that vanished between listing and opening projects nothing;
        // every other failure keeps its identity and stays fatal.
        ignoreMissingUpdateCandidateSecretFile(error);
        continue;
      }
      const entries: Dirent[] = [];
      // Breaking the iterator closes the handle; the cap bounds work, not correctness.
      for await (const dirent of handle) {
        entries.push(dirent);
        if (entries.length >= MAX_SCANNED_ENTRIES_PER_DIRECTORY) {
          break;
        }
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const dirent of entries) {
        if (selected.length >= MAX_CREDENTIAL_FILES) {
          break;
        }
        const entryPath = path.join(current.directory, dirent.name);
        if (dirent.isFile()) {
          selected.push(entryPath);
        } else if (dirent.isDirectory() && current.depth < MAX_CREDENTIAL_DEPTH) {
          nextLevel.push({ directory: entryPath, depth: current.depth + 1 });
        }
      }
    }
    level = nextLevel;
  }
  return selected;
}

/** List state-relative credential files the configured plugin-integration providers own. */
export async function collectUpdateCandidateSecretCredentialSources(params: {
  config: SourceConfig;
  sourceRoot: string;
}): Promise<string[]> {
  const credentialsRoot = path.join(params.sourceRoot, CREDENTIALS_DIRECTORY);
  const sources = new Set<string>();
  for (const provider of Object.values(params.config.secrets?.providers ?? {})) {
    const directory = providerCredentialDirectory(provider);
    if (!directory) {
      continue;
    }
    // A provider without material on disk is normal; only a real read error is not.
    const owned = path.join(credentialsRoot, directory);
    const exists = await fs.lstat(owned).then(
      (stat) => stat.isDirectory(),
      (error: unknown) => ignoreMissingUpdateCandidateSecretFile(error) ?? false,
    );
    if (!exists) {
      continue;
    }
    for (const source of await selectOwnedCredentialFiles(owned)) {
      sources.add(source);
    }
  }
  return [...sources].toSorted();
}

/** Project configured plugin-integration provider prerequisites into the private rehearsal copy. */
export function createUpdateCandidateSecretCredentialProjection(
  sourceRoot: string,
  targetPath: (source: string) => string,
  config: SourceConfig,
) {
  return {
    async copySources(): Promise<void> {
      const sources = await collectUpdateCandidateSecretCredentialSources({ config, sourceRoot });
      if (sources.length === 0) {
        return;
      }
      const sourceRootHandle = await root(sourceRoot);
      for (const source of sources) {
        const stat = await fs.lstat(source).then(
          (value) => value,
          (error: unknown) => {
            if (ignoreMissingUpdateCandidateSecretFile(error)) {
              return undefined;
            }
            throw error;
          },
        );
        // Copy bytes, never links, and leave oversized payloads to the provider's own error.
        if (!stat?.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
          continue;
        }
        // lstat keeps broken links visible to the same refusal as ordinary links.
        const opened = await sourceRootHandle
          .read(path.relative(sourceRoot, source), {
            hardlinks: "reject",
            symlinks: "reject",
            maxBytes: MAX_CREDENTIAL_FILE_BYTES,
          })
          .catch((error: unknown) => {
            // An alias or oversized payload the resolver would refuse anyway must not turn a
            // working serving installation into a blocked update; leave it out of the copy.
            if (error instanceof FsSafeError) {
              return undefined;
            }
            throw error;
          });
        if (!opened) {
          continue;
        }
        const target = targetPath(source);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, opened.buffer, { mode: 0o600, flag: "wx" });
      }
    },
  };
}
