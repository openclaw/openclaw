import { validateFleetImage, type FleetContainerRuntimeName } from "./cell-profile.js";

type ImageCommand = (
  runtime: FleetContainerRuntimeName,
  args: string[],
  options?: { allowFailure?: boolean },
) => Promise<{ stdout: string; stderr: string; code: number }>;

// Bound the container process as well as the host command: killing a Docker client
// alone does not necessarily terminate the daemon-owned container.
const GATEWAY_HELP_PROBE = `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['dist/index.js','gateway','--help'],{encoding:'utf8',timeout:30000,maxBuffer:1048576,killSignal:'SIGKILL'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.error?1:r.status??1);`;

export function requireFleetImageId(imageId: string): string {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(imageId)) {
    throw new Error("Cannot determine immutable Fleet image identity.");
  }
  return imageId;
}

export async function prepareFleetGatewayImage(
  execute: ImageCommand,
  runtime: FleetContainerRuntimeName,
  image: string,
): Promise<string> {
  validateFleetImage(image);
  const inspectArgs = ["image", "inspect", "--format", "{{.Id}}", image];
  let inspected = await execute(runtime, inspectArgs, { allowFailure: true });
  if (inspected.code !== 0) {
    await execute(runtime, ["pull", image]);
    inspected = await execute(runtime, inspectArgs);
  }
  const imageId = requireFleetImageId(inspected.stdout.trim());
  const help = await execute(
    runtime,
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "node",
      imageId,
      "-e",
      GATEWAY_HELP_PROBE,
    ],
    { allowFailure: true },
  );
  if (help.code !== 0 || !/^\s*--published-port(?:\s|=)/mu.test(help.stdout)) {
    throw new Error(
      `Image ${image} does not support gateway --published-port. Build or select a compatible OpenClaw image before changing this cell.`,
    );
  }
  return imageId;
}
