import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { podmanEntrypoints, podmanFixture } from "./podman.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
// Synthetic rootless fixture (including root CI); never used by a real Gateway.
const fixtureToken = "ab".repeat(32);
const tokenLine = `OPENCLAW_GATEWAY_TOKEN=${fixtureToken}\n`;
const backends = ["openssl", "python3", "od"] as const;

function runFixture(entrypoint: string, backend: (typeof backends)[number], exit: number) {
  const root = createTempDir("openclaw-podman-token-");
  const { config, command, run } = podmanFixture(root);
  const calls = path.join(root, "podman-calls");
  command("podman", 'printf "%s\\n" "$*" >> "$PODMAN_CALLS"');
  const emitted = backend === "od" ? `${" ab".repeat(32)}\n` : `${fixtureToken}\n`;
  // Python also normalizes config after success; that operation may decline.
  command(
    backend,
    `${backend === "python3" ? '[[ "$#" -eq 1 ]] || exit 0\n' : ""}if [[ "$GENERATOR_EXIT" -ne 0 ]]; then
  printf "fixture random source failed\\n" >&2
  exit "$GENERATOR_EXIT"
fi
printf '%s' '${emitted}'`,
  );
  const result = run(entrypoint, {
    GENERATOR_EXIT: String(exit),
    PODMAN_CALLS: calls,
  });
  return { result, token: path.join(config, ".env"), calls };
}

for (const entrypoint of Object.values(podmanEntrypoints)) {
  it.each(backends)(`${entrypoint} persists a successful %s token`, (backend) => {
    const { result, token } = runFixture(entrypoint, backend, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(token, "utf8")).toContain(tokenLine);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fixtureToken);
  });

  it.each(backends)(`${entrypoint} stops when %s token generation fails`, (backend) => {
    const { result, token, calls } = runFixture(entrypoint, backend, 7);
    expect(result.stderr).toContain("fixture random source failed");
    expect(result.status).toBe(7);
    expect(fs.existsSync(token)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain("Generated OPENCLAW_GATEWAY_TOKEN");
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").not.toMatch(/^run /m);
  });
}
