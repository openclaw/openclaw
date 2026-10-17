import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function runWithStubbedKubectl(
  args: string[],
  namespace: string,
  options: {
    deleteKustomizeStatus?: number;
  } = {},
) {
  const root = tempDirs.make("openclaw-k8s-delete-");
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "kubectl.log");
  mkdirSync(binDir);

  writeExecutable(
    path.join(binDir, "kubectl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OPENCLAW_KUBECTL_LOG"
if [[ "$1" == "delete" && "$2" == "-k" ]]; then
  exit "\${OPENCLAW_KUBECTL_DELETE_KUSTOMIZE_STATUS:-0}"
fi
if [[ "$1" == "get" && "$2" == "namespace" ]]; then
  exit 99
fi
case "$1" in
  cluster-info|delete) exit 0 ;;
  *) exit 99 ;;
esac
`,
  );
  writeExecutable(path.join(binDir, "openssl"), "#!/usr/bin/env bash\nexit 0\n");

  const result = spawnSync("bash", ["scripts/k8s/deploy.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_KUBECTL_DELETE_KUSTOMIZE_STATUS: String(options.deleteKustomizeStatus ?? 0),
      OPENCLAW_KUBECTL_LOG: logPath,
      OPENCLAW_NAMESPACE: namespace,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });

  return {
    calls: readFileSync(logPath, "utf8").trim().split("\n"),
    output: `${result.stdout}\n${result.stderr}`,
    result,
  };
}

describe("scripts/k8s/deploy.sh", () => {
  function runDeleteResourcesWithStubbedKubectl(
    namespace: string,
    options: {
      deleteKustomizeStatus?: number;
    } = {},
  ) {
    return runWithStubbedKubectl(["--delete-resources"], namespace, options);
  }

  it("keeps a custom namespace and unrelated workloads when the legacy delete mode is used", () => {
    const { calls, output, result } = runWithStubbedKubectl(["--delete"], "my-namespace");

    expect(result.status, output).toBe(0);
    expect(output).toContain("Deleting OpenClaw resources from namespace 'my-namespace'");
    expect(calls).toEqual([
      "cluster-info",
      `delete -k ${path.resolve("scripts/k8s/manifests")} -n my-namespace --ignore-not-found`,
      "delete secret openclaw-secrets -n my-namespace --ignore-not-found",
    ]);
    expect(calls).not.toContain("delete namespace my-namespace --ignore-not-found");
    expect(calls).not.toContain("get namespace my-namespace");
  });

  it("surfaces resource delete failures instead of reporting teardown success", () => {
    const { calls, output, result } = runDeleteResourcesWithStubbedKubectl("restricted-namespace", {
      deleteKustomizeStatus: 17,
    });

    expect(result.status, output).toBe(17);
    expect(output).toContain("Deleting OpenClaw resources from namespace 'restricted-namespace'");
    expect(calls).toEqual([
      "cluster-info",
      `delete -k ${path.resolve("scripts/k8s/manifests")} -n restricted-namespace --ignore-not-found`,
    ]);
    expect(output).not.toContain("Done.");
  });

  it("deletes the namespace only when the explicit namespace teardown mode is selected", () => {
    const { calls, output, result } = runWithStubbedKubectl(
      ["--delete-namespace"],
      "shared-namespace",
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("Deleting namespace 'shared-namespace' and all resources");
    expect(calls).toEqual(["cluster-info", "delete namespace shared-namespace --ignore-not-found"]);
  });
});
