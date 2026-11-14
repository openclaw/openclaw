import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { provider: "docker", engine: "docker", mode: "delete", unavailable: "", status: 0 },
  { provider: "podman", engine: "podman", mode: "create", unavailable: "", status: 0 },
  { provider: "docker", engine: "docker", mode: "create", unavailable: "", status: 0 },
  { provider: "", engine: "podman", mode: "delete", unavailable: "", status: 0 },
  { provider: "", engine: "docker", mode: "delete", unavailable: "podman", status: 0 },
  { provider: "docker", engine: "", mode: "delete", unavailable: "docker", status: 1 },
  { provider: "unsupported", engine: "", mode: "delete", unavailable: "", status: 1 },
])("selects $provider for $mode (unavailable=$unavailable)", (spec) => {
  const root = tempDirs.make("openclaw-kind-provider-");
  const log = path.join(root, "calls.log");
  writeFileSync(log, "");
  const stub = (name: string, body: string) =>
    writeFileSync(path.join(root, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  for (const engine of ["docker", "podman"]) {
    stub(engine, `[[ "$1" == info && "$UNAVAILABLE" != ${engine} ]]`);
  }
  stub(
    "kind",
    `printf 'kind:%s:%s\\n' "$KIND_EXPERIMENTAL_PROVIDER" "$*" >> "$CALLS"
case "$1 $2" in
  'get clusters') [[ "$MODE" != delete ]] || echo example ;;
  'delete cluster') ;;
  'create cluster') cat >/dev/null ;;
  *) exit 90 ;;
esac`,
  );
  stub("kubectl", `printf 'kubectl:%s\\n' "$*" >> "$CALLS"`);
  const result = spawnSync(
    "bash",
    [
      "scripts/k8s/create-kind.sh",
      "--name",
      "example",
      ...(spec.mode === "delete" ? ["--delete"] : []),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        KIND_EXPERIMENTAL_PROVIDER: spec.provider,
        UNAVAILABLE: spec.unavailable,
        MODE: spec.mode,
        CALLS: log,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(spec.status);
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  expect(calls).toEqual(
    spec.status
      ? []
      : [
          `kind:${spec.engine}:get clusters`,
          `kind:${spec.engine}:${spec.mode} cluster --name example${spec.mode === "create" ? " --config -" : ""}`,
          ...(spec.mode === "create"
            ? [
                "kubectl:--context kind-example wait --for=condition=Ready nodes --all --timeout=120s",
              ]
            : []),
        ],
  );
});
