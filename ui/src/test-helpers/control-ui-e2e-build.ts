import { fileURLToPath } from "node:url";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.ts";
import type { ControlUiE2eBuildOptions } from "./control-ui-e2e-build-publication.ts";

export async function buildProductionControlUiE2e(
  outDir: string,
  buildId: string,
  options: ControlUiE2eBuildOptions = {},
): Promise<void> {
  await buildControlUiE2e(outDir, buildId, options, "--production-build");
}

export async function buildControlUiE2e(
  outDir: string,
  buildId: string,
  options: ControlUiE2eBuildOptions,
  command: "--production-build" | "--production-preview-build" | "--bundled-build",
): Promise<void> {
  // Compile outside Vitest so its NODE_ENV=test cannot disable production
  // behavior or select development dependencies in the shared browser artifact.
  const uiRoot = fileURLToPath(new URL("../../", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) {
      delete env[key];
    }
  }
  const { runManagedCommand } = await import("../../../scripts/lib/managed-child-process.mts");
  const stderr = createBoundedChildOutput(10 * 1024 * 1024);
  const overflow = new AbortController();
  let stderrBytes = 0;
  let code: number | undefined;
  let failure: unknown;
  try {
    code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./control-ui-e2e.ts", import.meta.url)),
        command,
        outDir,
        ...(options.includeBootGroups === false ? ["--individual-boot-modules"] : []),
        ...(options.protocolVersion === undefined
          ? []
          : [`--protocol-version=${options.protocolVersion}`]),
      ],
      cwd: uiRoot,
      env,
      shell: false,
      stdio: ["ignore", "inherit", "pipe"],
      requireProcessTreeExit: process.platform !== "win32",
      signal: overflow.signal,
      onReady(child) {
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr.append(chunk);
          stderrBytes += chunk.byteLength;
          if (stderrBytes > 10 * 1024 * 1024) {
            overflow.abort();
          }
        });
      },
    });
  } catch (error) {
    failure = error;
  }
  if (code !== 0) {
    throw new Error(
      `Production Control UI build failed (exit ${code ?? "unknown"}):\n${stderr.text() || (failure instanceof Error ? failure.message : "See streamed build output above.")}`,
      { cause: failure },
    );
  }
}
