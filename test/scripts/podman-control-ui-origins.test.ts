import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { podmanEntrypoints, podmanFixture } from "./podman.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const localOrigins = ["http://127.0.0.1:43123", "http://localhost:43123"];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const publicOrigin = "https://public.example";
function configJson(controlUi: Record<string, unknown>, extraGateway = {}) {
  return json({ label: "keep", gateway: { publicOrigin, controlUi, ...extraGateway }, tail: [1] });
}

function runPodman(operation: keyof typeof podmanEntrypoints, input: string, python = true) {
  const root = tempDirs.make("openclaw-podman-origins-");
  const { config, command, run } = podmanFixture(root, python ? ["python3"] : []);
  const configPath = path.join(config, "openclaw.json");
  const cliCalls = path.join(root, "cli-calls");
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, input, { mode: 0o640 });
  fs.writeFileSync(path.join(config, ".env"), "OPENCLAW_GATEWAY_TOKEN=fixture-token\n", {
    mode: 0o600,
  });
  command("podman", "exit 0");
  command(
    "openclaw",
    `printf '%s\\n' "$*" >> "$CLI_CALLS"
case "$*" in
  'config get gateway.bind') echo lan ;;
  'config get gateway.controlUi.allowedOrigins') echo '["https://fallback.example"]' ;;
esac`,
  );
  const result = run(podmanEntrypoints[operation], {
    OPENCLAW_PODMAN_GATEWAY_HOST_PORT: "43123",
    CLI_CALLS: cliCalls,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(config).filter((name) => name.startsWith(".config.tmp."))).toEqual([]);
  return {
    result,
    configPath,
    output: fs.readFileSync(configPath, "utf8"),
    mode: fs.statSync(configPath).mode & 0o777,
    calls: fs.existsSync(cliCalls) ? fs.readFileSync(cliCalls, "utf8") : "",
  };
}

describe.each(["seed", "sync"] as const)("Podman %s Control UI origins", (operation) => {
  it("preserves config bytes and the distinct localhost and duplicate policies", () => {
    const input = configJson({
      allowedOrigins: [
        " http://localhost:9999 ",
        " https://remote.example ",
        "https://remote.example",
        "http://127.0.0.1:43123",
        " ",
        null,
        7,
      ],
      enabled: true,
    });
    const fixture = runPodman(operation, input);
    const expectedOrigins =
      operation === "seed"
        ? ["https://remote.example", "https://remote.example", ...localOrigins]
        : ["http://localhost:9999", "https://remote.example", ...localOrigins];
    expect(fixture.output).toBe(
      configJson({ allowedOrigins: expectedOrigins, enabled: true }, { mode: "local" }),
    );
    expect(fixture.mode).toBe(0o600);
    expect(fixture.result.stderr).toBe("");
    expect(fixture.calls).not.toContain("config set");
  });

  it.each([
    ["inherits a public origin", publicOrigin, undefined, {}],
    ["ignores an empty public origin", " ", undefined, { allowedOrigins: localOrigins }],
    ["honors explicit empty origins", publicOrigin, [], { allowedOrigins: localOrigins }],
  ])("%s", (_label, origin, allowedOrigins, expectedControlUi) => {
    const fixture = runPodman(
      operation,
      json({ gateway: { publicOrigin: origin, controlUi: { allowedOrigins } } }),
    );
    expect(fixture.output).toBe(
      json({ gateway: { publicOrigin: origin, controlUi: expectedControlUi, mode: "local" } }),
    );
    expect(fixture.result.stderr).toBe("");
  });

  it.each([
    ["[]", "expected top-level object", true],
    ['{"gateway":[]}', "expected gateway object", true],
    ['{"gateway":{"controlUi":[]}}', "expected gateway.controlUi object", true],
    ["{", "malformed", true],
    ["{}", "no-python", false],
  ] as const)("preserves config on %s failure (%s)", (input, error, python) => {
    const fixture = runPodman(operation, input, python);
    expect(fixture.output).toBe(input);
    expect(fixture.mode).toBe(0o640);
    const diagnostic =
      error === "malformed"
        ? `Warning: unable to ${operation} gateway.controlUi.allowedOrigins in ${fixture.configPath}: existing config is not strict JSON (Expecting property name enclosed in double quotes: line 1 column 2 (char 1)). Leaving file unchanged.\n`
        : error === "no-python"
          ? `Warning: python3 not found; unable to ${operation} gateway.controlUi.allowedOrigins in ${fixture.configPath}.\n`
          : `${fixture.configPath}: ${error}\n`;
    expect(fixture.result.stderr).toBe(diagnostic);
    if (python) {
      expect(fixture.calls.includes("config set gateway.controlUi.allowedOrigins")).toBe(
        operation === "sync",
      );
    } else {
      expect(fixture.calls).not.toContain("config set");
    }
  });
});
