import { vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { probeGatewayUrl, probeLocalCommand } from "./probes.js";

export async function withSystemAgentOverviewSources<T>(
  snapshot: ConfigFileSnapshot,
  run: () => Promise<T>,
  options: {
    probeLocalCommand?: typeof probeLocalCommand;
    probeGatewayUrl?: typeof probeGatewayUrl;
  } = {},
): Promise<T> {
  // Shared workers can load this helper before a later suite installs module mocks.
  const [config, probes, docsPaths] = await Promise.all([
    import("../config/config.js"),
    import("./probes.js"),
    import("../agents/docs-path.js"),
  ]);
  const mocks = [
    vi.spyOn(config, "readConfigFileSnapshot").mockResolvedValue(snapshot),
    vi
      .spyOn(probes, "probeLocalCommand")
      .mockImplementation(
        options.probeLocalCommand ?? (async (command) => ({ command, found: false })),
      ),
    vi
      .spyOn(probes, "probeGatewayUrl")
      .mockImplementation(options.probeGatewayUrl ?? (async (url) => ({ url, reachable: false }))),
    vi.spyOn(docsPaths, "resolveOpenClawReferencePaths").mockResolvedValue({
      sourcePath: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
    }),
  ];
  try {
    return await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: snapshot.path || "/tmp/openclaw.json",
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      run,
    );
  } finally {
    for (const mock of mocks.toReversed()) {
      mock.mockRestore();
    }
  }
}
