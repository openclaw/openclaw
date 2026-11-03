import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";

/** Deny filesystem removal in both the staging worker and its independent native cleanup owner. */
export function installSqliteSnapshotRemovalFault(options: {
  directory: string;
  code: "EBUSY" | "EPERM" | "EACCES";
  roots?: readonly string[];
}) {
  const sentinel = path.join(options.directory, "snapshot-removal-roots.json");
  const receipt = path.join(options.directory, "snapshot-removal-receipts.jsonl");
  const roots = [...(options.roots ?? [])].map((root) => fs.realpathSync(root));
  const arm = () => fs.writeFileSync(sentinel, JSON.stringify(roots));
  arm();
  const preloadPath = path.join(options.directory, "snapshot-removal-fault.mjs");
  fs.writeFileSync(
    preloadPath,
    `
import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { threadId } from "node:worker_threads";
const sentinel = ${JSON.stringify(sentinel)};
const receipt = ${JSON.stringify(receipt)};
const remove = promises.rm.bind(promises);
const checkRemoval = (target, options) => {
  if (typeof target === "string" && fs.existsSync(sentinel) && fs.existsSync(target)) {
    const actual = fs.realpathSync(target);
    const roots = JSON.parse(fs.readFileSync(sentinel, "utf8"));
    if (roots.some(root => actual === root || actual.startsWith(root + path.sep) ||
        (options?.recursive && root.startsWith(actual + path.sep)))) {
      fs.appendFileSync(receipt, JSON.stringify({ threadId, target: actual }) + "\\n");
      throw Object.assign(new Error("controlled snapshot removal failure"), { code: ${JSON.stringify(options.code)} });
    }
  }
};
promises.rm = async (target, options) => {
  checkRemoval(target, options);
  return await remove(target, options);
};
`,
  );
  const preloadUrl = pathToFileURL(preloadPath).href;
  const nativeUrl = resolveRuntimeProcessEntrypointUrl("sqliteReadOnlyNativeResource").href;
  const resourcePath = path.join(options.directory, "snapshot-removal-resource.mjs");
  fs.writeFileSync(
    resourcePath,
    `import ${JSON.stringify(preloadUrl)};\nexport { createNativeWorkerResource } from ${JSON.stringify(nativeUrl)};\n`,
  );
  const resourceUrl = pathToFileURL(resourcePath).href;
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging").href;
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const create = source.create.bind(source);
  const creation = vi
    .spyOn(source, "create")
    .mockImplementation((filename, workerOptions, resource, taskPorts) =>
      create(
        filename,
        String(filename) === stagingUrl
          ? {
              ...workerOptions,
              execArgv: [...(workerOptions?.execArgv ?? []), "--import", preloadUrl],
            }
          : workerOptions,
        resource?.moduleUrl === nativeUrl ? { ...resource, moduleUrl: resourceUrl } : resource,
        taskPorts,
      ),
    );
  return {
    denyRoot(directory: string) {
      roots.push(fs.realpathSync(directory));
      arm();
    },
    count: () =>
      fs.existsSync(receipt) ? fs.readFileSync(receipt, "utf8").trim().split("\n").length : 0,
    allowRemoval: () => fs.rmSync(sentinel, { force: true }),
    restore() {
      creation.mockRestore();
    },
  };
}
