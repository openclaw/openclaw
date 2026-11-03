import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { DirectoryWalkLimitError, listDirectoryTreeStrict } from "./directory-walk.js";
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
/** Provider identities name one directory inside the credential root, never a path. */
const CREDENTIAL_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

type SourceConfig = { secrets?: { providers?: Record<string, SecretProviderConfig> } };

/**
 * Name the state-relative credential directories a provider actually owns.
 *
 * Only a plugin-integration resolver locates material by plugin identity
 * (`credentials/<pluginId>`), so the identity — never the operator-chosen config
 * alias — is the ownership signal. A manual exec resolver runs an arbitrary command
 * whose prerequisite cannot be derived from config, so it projects nothing; treating
 * its alias as ownership would drag an unrelated plugin's secret into the rehearsal.
 */
function providerCredentialDirectories(provider: SecretProviderConfig): string[] {
  if (provider.source !== "exec" || !("pluginIntegration" in provider)) {
    return [];
  }
  const integration = provider.pluginIntegration;
  const names = [integration.pluginId, integration.integrationId].filter(
    (name): name is string => typeof name === "string" && CREDENTIAL_DIRECTORY_NAME.test(name),
  );
  return [...new Set(names)];
}

/** List state-relative credential files the configured plugin-integration providers own. */
export async function collectUpdateCandidateSecretCredentialSources(params: {
  config: SourceConfig;
  sourceRoot: string;
}): Promise<string[]> {
  const credentialsRoot = path.join(params.sourceRoot, CREDENTIALS_DIRECTORY);
  const sources = new Set<string>();
  const addDirectory = async (directory: string) => {
    // A provider without material on disk is normal; only a real read error is not.
    const exists = await fs.lstat(directory).then(
      (stat) => stat.isDirectory(),
      (error: unknown) => ignoreMissingUpdateCandidateSecretFile(error) ?? false,
    );
    if (!exists) {
      return;
    }
    let entries;
    try {
      entries = await listDirectoryTreeStrict(directory, {
        maxDepth: MAX_CREDENTIAL_DEPTH,
        maxEntries: MAX_CREDENTIAL_FILES * 2,
      });
    } catch (error) {
      // An over-limit directory holds unrelated material the resolver never reads; it must
      // not turn a working serving installation into a blocked update. Leave it out.
      if (error instanceof DirectoryWalkLimitError) {
        return;
      }
      throw error;
    }
    for (const { relativePath, dirent } of entries) {
      // Aliases are refused instead of followed: the copy must stay inside the rehearsal.
      if (!dirent.isFile() || sources.size >= MAX_CREDENTIAL_FILES) {
        continue;
      }
      sources.add(path.join(directory, relativePath));
    }
  };
  for (const provider of Object.values(params.config.secrets?.providers ?? {})) {
    for (const directory of providerCredentialDirectories(provider)) {
      await addDirectory(path.join(credentialsRoot, directory));
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
