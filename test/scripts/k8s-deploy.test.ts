import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runWithStubbedKubectl(
  mode: string,
  namespace: string,
  deleteKustomizeStatus = 0,
  clusterStatus = 0,
) {
  const root = tempDirs.make("openclaw-k8s-delete-");
  const logPath = path.join(root, "kubectl.log");
  writeFileSync(logPath, "");

  writeFileSync(
    path.join(root, "kubectl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OPENCLAW_KUBECTL_LOG"
if [[ "$1" == "delete" && "$2" == "-k" ]]; then
  exit "\${OPENCLAW_KUBECTL_DELETE_KUSTOMIZE_STATUS:-0}"
fi
case "$1" in
  cluster-info) exit "\${OPENCLAW_KUBECTL_CLUSTER_STATUS:-0}" ;;
  delete) exit 0 ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(root, "openssl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const result = spawnSync("bash", ["scripts/k8s/deploy.sh", mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_KUBECTL_DELETE_KUSTOMIZE_STATUS: String(deleteKustomizeStatus),
      OPENCLAW_KUBECTL_CLUSTER_STATUS: String(clusterStatus),
      OPENCLAW_KUBECTL_LOG: logPath,
      OPENCLAW_NAMESPACE: namespace,
      PATH: `${root}:${process.env.PATH ?? ""}`,
    },
  });

  return {
    calls: readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean),
    output: `${result.stdout}\n${result.stderr}`,
    result,
  };
}

it.each(["-h", "--help"])("shows %s without contacting an unavailable cluster", (mode) => {
  const { calls, output, result } = runWithStubbedKubectl(mode, "help-only", 0, 1);
  expect(result.status, output).toBe(0);
  expect(output).toContain("Usage: ./scripts/k8s/deploy.sh [OPTION]");
  expect(calls).toEqual([]);
});

it("still requires a reachable cluster before deleting resources", () => {
  const { calls, output, result } = runWithStubbedKubectl("--delete", "help-only", 0, 1);
  expect(result.status, output).toBe(1);
  expect(output).toContain("Cannot connect to cluster.");
  expect(calls).toEqual(["cluster-info"]);
});

it.each([
  ["--delete", "my-namespace", 0],
  ["--delete-resources", "restricted-namespace", 17],
  ["--delete-namespace", "shared-namespace", 0],
] satisfies [string, string, number][])(
  "k8s teardown %s in %s (status %s)",
  (mode, namespace, status) => {
    const { calls, output, result } = runWithStubbedKubectl(mode, namespace, status);
    const wholeNamespace = mode === "--delete-namespace";
    expect(result.status, output).toBe(status);
    expect(output).toContain(
      wholeNamespace
        ? `Deleting namespace '${namespace}' and all resources`
        : `Deleting OpenClaw resources from namespace '${namespace}'`,
    );
    expect(calls).toEqual([
      "cluster-info",
      ...(wholeNamespace
        ? [`delete namespace ${namespace} --ignore-not-found`]
        : [
            `delete -k ${path.resolve("scripts/k8s/manifests")} -n ${namespace} --ignore-not-found`,
            ...(status
              ? []
              : [`delete secret openclaw-secrets -n ${namespace} --ignore-not-found`]),
          ]),
    ]);
    if (status) {
      expect(output).not.toContain("Done.");
    }
  },
);
