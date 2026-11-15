import { spawn, execFile } from "node:child_process";
// Container transport for the real built Gateway command; no admission/runtime substitution.
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { managedSetupPodmanEnv } from "./managed-setup-podman.mjs";
const run = promisify(execFile);
const [configuration, ...gatewayArgs] = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(configuration, "utf8"));
if (process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR && process.env.OPENCLAW_CONFIG_PATH) {
  const observed = JSON.parse(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const destination = process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR;
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(
    destination + "/gateway-plugin-config.json",
    JSON.stringify(
      {
        allow: observed.plugins?.allow,
        load: observed.plugins?.load,
        entry: observed.plugins?.entries?.["setup-proof-repository"],
        bundled: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
      },
      null,
      2,
    ),
  );
}
const podman = (args) =>
  run("podman", args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: managedSetupPodmanEnv(process.env),
  });
if (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD) {
  throw new Error("Setup proof must not forward a shared Gateway credential");
}
const image = JSON.parse((await podman(["image", "inspect", config.image])).stdout)[0];
const imageKeys = (image.Config.Env ?? []).map((entry) => entry.slice(0, entry.indexOf("=")));
const explicit = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "GH_TOKEN",
  "OPENAI_API_KEY",
]);
const keys = Object.keys(process.env).filter(
  (key) => explicit.has(key) || key.startsWith("OPENCLAW_") || key.startsWith("_OPENCLAW_"),
);
const args = [
  "run",
  "--interactive",
  "--rm",
  "--pull=never",
  "--name",
  config.name,
  "--label",
  `openclaw.setup-gateway=${config.owner}`,
  "--network=host",
  "--pid=private",
  "--ipc=private",
  "--privileged=false",
  "--user",
  "0",
  "--volume",
  `${config.repoRoot}:${config.repoRoot}:ro`,
  "--volume",
  `${config.artifactRoot}:${config.artifactRoot}:rw`,
  "--volume",
  `${config.stateRoot}:${config.stateRoot}:rw`,
  "--volume",
  `${config.nodePath}:/opt/setup-proof-node:ro`,
  "--workdir",
  config.repoRoot,
  ...imageKeys.flatMap((key) => ["--env", `${key}=`]),
  ...keys.flatMap((key) => ["--env", key]),
  "--env",
  "HOME=/home/worker",
  "--env",
  "TMPDIR=/tmp",
  "--entrypoint",
  "/opt/setup-proof-node",
  config.image,
  ...gatewayArgs,
];
let stopping;
const stop = () => {
  stopping ??= (async () => {
    const owned = (
      await podman([
        "ps",
        "-a",
        "--filter",
        `name=${config.name}`,
        "--filter",
        `label=openclaw.setup-gateway=${config.owner}`,
        "--format",
        "{{.Names}}",
      ])
    ).stdout.trim();
    if (owned === config.name) {
      await podman(["stop", "--time", "8", config.name]);
    }
  })().catch(
    /** @param {unknown} error */ (error) => {
      console.error(
        "Owned Gateway container stop failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const child = spawn("podman", args, { stdio: "inherit", env: managedSetupPodmanEnv(process.env) });
child.once("error", (error) => {
  console.error("Gateway container transport failed:", error.code);
  process.exitCode = 1;
});
child.once("exit", async (code, signal) => {
  await stopping;
  process.exitCode = code ?? (signal ? 1 : 0);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
});
