/**
 * Private-local SDK facade for the Codex client version that ChatGPT model
 * discovery reports. The bundled Codex plugin owns binary selection.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readHandedOffCodexClientVersion } from "./codex-client-version-handoff.internal.js";

type CodexClientVersionParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Agent whose Codex home decides desktop-first startup; absent means the default. */
  agentDir?: string;
};

type CodexClientVersionSurface = {
  resolveCodexClientVersion: (params: CodexClientVersionParams) => Promise<string>;
};

/**
 * Resolves the version of the Codex binary that managed Codex turns run in this
 * process tree. Catalog workers return the value their parent process handed
 * off. Returns undefined when the Codex plugin is inactive or unavailable;
 * callers then report their bundled pin.
 */
export async function resolveCodexClientVersion(
  params: CodexClientVersionParams,
): Promise<string | undefined> {
  const handedOff = readHandedOffCodexClientVersion();
  if (handedOff) {
    return handedOff.version;
  }
  try {
    // Registry-backed plugin loading stays lazy so importing this facade does
    // not pull runtime preparation into plugin registration.
    const { tryLoadActivatedBundledPluginPublicSurfaceModule } =
      await import("./facade-runtime.js");
    const surface =
      await tryLoadActivatedBundledPluginPublicSurfaceModule<CodexClientVersionSurface>({
        dirName: "codex",
        artifactBasename: "client-version-api.js",
      });
    return await surface?.resolveCodexClientVersion(params);
  } catch {
    return undefined;
  }
}
