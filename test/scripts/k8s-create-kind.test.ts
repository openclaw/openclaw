import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runCreateKind(args: string[], env: { provider?: string; dockerUp?: boolean }) {
  const root = tempDirs.make("openclaw-k8s-kind-");
  const logPath = path.join(root, "calls.log");
  const engine = `#!/usr/bin/env bash
[[ "$1" == "info" ]] || exit 99
[[ "$(basename "$0")" == docker ]] && exit "$OPENCLAW_DOCKER_INFO_STATUS"
exit 0
`;
  writeFileSync(path.join(root, "docker"), engine, { mode: 0o755 });
  writeFileSync(path.join(root, "podman"), engine, { mode: 0o755 });
  writeFileSync(
    path.join(root, "kind"),
    `#!/usr/bin/env bash
printf 'kind:%s:%s\\n' "\${KIND_EXPERIMENTAL_PROVIDER:-}" "$*" >> "$OPENCLAW_CALL_LOG"
[[ "$1 $2" == "get clusters" ]] && echo example
[[ "$1" == "create" ]] && cat >/dev/null
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(root, "kubectl"),
    `#!/usr/bin/env bash\nprintf 'kubectl:%s\\n' "$*" >> "$OPENCLAW_CALL_LOG"\n`,
    { mode: 0o755 },
  );

  const { KIND_EXPERIMENTAL_PROVIDER: _ignored, ...baseEnv } = process.env;
  const result = spawnSync("bash", ["scripts/k8s/create-kind.sh", "--name", "example", ...args], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      ...(env.provider === undefined ? {} : { KIND_EXPERIMENTAL_PROVIDER: env.provider }),
      OPENCLAW_CALL_LOG: logPath,
      OPENCLAW_DOCKER_INFO_STATUS: env.dockerUp === false ? "1" : "0",
      PATH: `${root}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    calls: existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [],
    output: `${result.stdout}\n${result.stderr}`,
    status: result.status,
  };
}

it.each([
  [undefined, ["kind:podman:get clusters", "kind:podman:delete cluster --name example"]],
  ["docker", ["kind:docker:get clusters", "kind:docker:delete cluster --name example"]],
] as const)("routes Kind lookup and deletion to provider %s", (provider, calls) => {
  const run = runCreateKind(["--delete"], { provider });
  expect(run.status, run.output).toBe(0);
  expect(run.calls).toEqual(calls);
});

it.each([
  ["docker", false, "Docker daemon is not running"],
  ["nerdctl", true, "Unsupported KIND_EXPERIMENTAL_PROVIDER 'nerdctl'"],
] as const)("rejects selected provider %s without falling back", (provider, dockerUp, message) => {
  const run = runCreateKind([], { provider, dockerUp });
  expect(run.status).toBe(1);
  expect(run.output).toContain(message);
  expect(run.calls).toEqual([]);
});
