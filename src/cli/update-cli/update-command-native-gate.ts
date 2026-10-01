import { mergeProcessEnv } from "../../infra/process-env.js";

/** Keep Node startup hooks behind admission without changing the native payload's environment. */
export function prepareUpdateCommandNativeGate(
  ticket: string,
  sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>,
  platform: NodeJS.Platform = process.platform,
) {
  const env = mergeProcessEnv(sources, platform);
  const key = Object.keys(env).find((name) =>
    platform === "win32" ? name.toUpperCase() === "NODE_OPTIONS" : name === "NODE_OPTIONS",
  );
  const input = JSON.stringify([ticket, key === undefined ? null : [key, env[key]]]);
  if (key !== undefined) {
    delete env[key];
  }
  // The loaded source survives package replacement. Only the expected byte count
  // enters argv; caller options stay on the private pipe until the owner admits it.
  const source = `
  const { spawn } = await import("node:child_process");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > ${Buffer.byteLength(input)}) process.exit(1);
    chunks.push(chunk);
  }
  if (bytes !== ${Buffer.byteLength(input)}) process.exit(1);
  let admission;
  try { admission = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
  catch { process.exit(1); }
  if (!Array.isArray(admission) || admission.length !== 2 ||
      typeof admission[0] !== "string" || !/^[0-9a-f-]{36}$/.test(admission[0])) process.exit(1);
  const [ticket, nodeOptions] = admission;
  if (nodeOptions !== null && (!Array.isArray(nodeOptions) || nodeOptions.length !== 2 ||
      typeof nodeOptions[0] !== "string" || typeof nodeOptions[1] !== "string" || nodeOptions[1].includes("\\0") ||
      (process.platform === "win32" ? nodeOptions[0].toUpperCase() : nodeOptions[0]) !== "NODE_OPTIONS")) process.exit(1);
  const env = { ...process.env };
  if (nodeOptions !== null) env[nodeOptions[0]] = nodeOptions[1];
  const child = spawn(process.argv[1], process.argv.slice(2), {
    env, stdio: ["ignore", "inherit", "inherit"], detached: false, windowsHide: true,
  });
  let spawnFailed = false;
  child.once("error", (error) => {
    spawnFailed = true;
    const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "_";
    process.stderr.write("native-spawn-error:" + ticket + ":" + code);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    if (spawnFailed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
`;
  return { source, env, input };
}
