import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "./openai-responses-sse.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

export const UPGRADE_REPLY = "SYNTHETIC_STABLE_UPGRADE_RETAINED_REPLY";

export async function createQuestionUpgradeFixture(stableRoot: string, signal: AbortSignal) {
  const entrypoint = [path.join(stableRoot, "openclaw.mjs")];
  const provider = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          for await (const chunk of request) {
            // Drain the real provider transport; input is never printed or retained.
            void chunk;
          }
          writeOpenAiResponsesText(response, {
            text: UPGRADE_REPLY,
            messageId: "msg_upgrade",
            responseId: "resp_upgrade",
          });
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
        );
      }),
  });
  const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${provider.claim.port}/v1`);
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>>;
  try {
    instance = await createOpenClawTestInstance({
      name: "installed-stable-question-upgrade",
      entrypoint,
      signal,
      config: {
        update: { checkOnStart: false },
        browser: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        agents: {
          defaults: {
            heartbeat: { every: "0m" },
            model: { primary: model.modelRef },
            models: {
              [model.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "merge",
          providers: {
            [model.providerId]: {
              ...model.config,
              agentRuntime: { id: "openclaw" },
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
  } catch (error) {
    provider.listener.closeAllConnections();
    await provider.releaseListener();
    await provider.claim.release();
    throw error;
  }
  return {
    instance,
    model,
    useBinary(binary: string) {
      if (instance.child) {
        throw new Error("Binary cutover requires the native Gateway owner to be stopped");
      }
      entrypoint[0] = binary;
    },
    async cleanup() {
      try {
        await instance.cleanup();
      } finally {
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      }
    },
  };
}

export function parseUpgradeCliJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value)) {
    throw new Error("Native CLI did not return a JSON object");
  }
  return value;
}

export async function inspectUpgradeDatabases(root: string) {
  const rows: Array<{
    relativePath: string;
    version: number;
    digest: string;
    cacheDigest?: string;
    cacheCount?: number;
  }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
      } else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        /* sqlite-allow-raw -- Read-only inspection of fully stopped installed-binary upgrade proof databases. */
        const database = openNodeSqliteDatabase(filename, { readOnly: true });
        try {
          const integrity = database.prepare("PRAGMA integrity_check").all();
          if (
            integrity.length !== 1 ||
            integrity[0]?.integrity_check !== "ok" ||
            database.prepare("PRAGMA foreign_key_check").all().length !== 0
          ) {
            throw new Error(
              "Installed upgrade proof database failed integrity or foreign-key validation",
            );
          }
          const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
          const tables = database
            .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
            .all();
          if (!tables.some((table) => table.name === "schema_meta")) {
            continue;
          }
          const cache = tables.some((table) => table.name === "cache_entries")
            ? database
                .prepare(
                  "SELECT scope,key,value_json,hex(blob) AS blob,expires_at,updated_at FROM cache_entries ORDER BY scope,key",
                )
                .all()
            : undefined;
          rows.push({
            relativePath: path.relative(root, filename),
            version,
            digest: createHash("sha256")
              .update(await readFile(filename))
              .digest("hex"),
            ...(cache
              ? {
                  cacheCount: cache.length,
                  cacheDigest: createHash("sha256").update(JSON.stringify(cache)).digest("hex"),
                }
              : {}),
          });
        } finally {
          database.close();
        }
      }
    }
  };
  await visit(root);
  return rows.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function activateUpgradeBackup(params: {
  root: string;
  restoreTarget: string;
  restored: Record<string, unknown>;
}) {
  const { restored: result } = params;
  if (
    result.ok !== true ||
    typeof result.targetPath !== "string" ||
    path.resolve(result.targetPath) !== path.resolve(params.restoreTarget) ||
    typeof result.archiveRoot !== "string" ||
    !result.archiveRoot ||
    result.archiveRoot === "." ||
    result.archiveRoot === ".." ||
    result.archiveRoot.includes("/") ||
    result.archiveRoot.includes("\\") ||
    typeof result.assetCount !== "number" ||
    !Number.isSafeInteger(result.assetCount) ||
    result.assetCount <= 0
  ) {
    throw new Error("Invalid verified restore result");
  }
  const manifestPath = path.join(params.restoreTarget, result.archiveRoot, "manifest.json");
  const manifestRelative = path.relative(
    await realpath(params.restoreTarget),
    await realpath(manifestPath),
  );
  if (!manifestRelative || manifestRelative.startsWith("..") || path.isAbsolute(manifestRelative)) {
    throw new Error("Restored manifest escaped the verified staging target");
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !isRecord(manifest) ||
    manifest.archiveRoot !== result.archiveRoot ||
    manifest.createdAt !== result.createdAt ||
    manifest.runtimeVersion !== result.runtimeVersion ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== result.assetCount
  ) {
    throw new Error("Restored manifest disagrees with the verified archive result");
  }
  const prepared: Array<{ target: string; restored: string }> = [];
  for (const asset of manifest.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.sourcePath !== "string" ||
      typeof asset.archivePath !== "string" ||
      !asset.archivePath.startsWith(`${result.archiveRoot}/`) ||
      asset.archivePath.includes("\\")
    ) {
      throw new Error("Invalid verified backup asset");
    }
    const target = path.resolve(asset.sourcePath);
    const relative = path.relative(params.root, target);
    const restored = path.resolve(params.restoreTarget, asset.archivePath);
    const restoredRelative = path.relative(params.restoreTarget, restored);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      restoredRelative.startsWith("..") ||
      path.isAbsolute(restoredRelative)
    ) {
      throw new Error("Backup activation escaped the isolated fixture root");
    }
    await stat(restored);
    for (const [base, source] of [
      [params.root, target],
      [params.restoreTarget, restored],
    ]) {
      if (!base || !source) {
        throw new Error("Backup activation path is missing");
      }
      const canonicalRelative = path.relative(await realpath(base), await realpath(source));
      if (
        !canonicalRelative ||
        canonicalRelative.startsWith("..") ||
        path.isAbsolute(canonicalRelative)
      ) {
        throw new Error("Backup activation physical path escaped the isolated fixture");
      }
    }
    prepared.push({ target, restored });
  }
  const quarantine = path.join(params.root, "upgrade-quarantine");
  await mkdir(quarantine);
  let count = 0;
  for (const { target, restored } of prepared) {
    await rename(target, path.join(quarantine, String(count)));
    await cp(restored, target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    count += 1;
  }
  return count;
}
