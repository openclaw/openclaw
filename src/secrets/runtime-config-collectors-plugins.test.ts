import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import {
  createResolverContext,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function makeContext(sourceConfig: OpenClawConfig): ResolverContext {
  return createResolverContext({
    sourceConfig,
    env: {},
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("collectPluginConfigAssignments", () => {
  it("collects SecretRef assignments from plugin MCP server env vars", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                github: {
                  command: "npx",
                  args: ["-y", "@modelcontextprotocol/server-github"],
                  env: {
                    GITHUB_TOKEN: envRef("GITHUB_TOKEN"),
                    PLAIN_VAR: "plain-value",
                  },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);
    const defaults: SecretDefaults = undefined;

    collectPluginConfigAssignments({ config, defaults, context });

    // Only the SecretRef value should produce an assignment (not the plain string)
    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]?.path).toBe(
      "plugins.entries.acpx.config.mcpServers.github.env.GITHUB_TOKEN",
    );
    expect(context.assignments[0]?.expected).toBe("string");
  });

  it("resolves assignments via apply callback", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                mcp1: {
                  command: "node",
                  env: {
                    API_KEY: envRef("MY_API_KEY"),
                  },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(1);
    context.assignments[0]?.apply("resolved-key-value");

    // The apply callback should mutate the config in place
    const entries = config.plugins?.entries as Record<string, Record<string, unknown>>;
    const mcpServers = (entries?.acpx?.config as Record<string, unknown>)?.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    const env = mcpServers?.mcp1?.env as Record<string, unknown>;
    expect(env?.API_KEY).toBe("resolved-key-value");
  });

  it("collects from multiple plugins and servers", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "a", env: { K1: envRef("K1") } },
                s2: { command: "b", env: { K2: envRef("K2"), K3: envRef("K3") } },
              },
            },
          },
          other: {
            config: {
              mcpServers: {
                s3: { command: "c", env: { K4: envRef("K4") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(4);
    const paths = context.assignments.map((a) => a.path).toSorted();
    expect(paths).toEqual([
      "plugins.entries.acpx.config.mcpServers.s1.env.K1",
      "plugins.entries.acpx.config.mcpServers.s2.env.K2",
      "plugins.entries.acpx.config.mcpServers.s2.env.K3",
      "plugins.entries.other.config.mcpServers.s3.env.K4",
    ]);
  });

  it("skips entries without config or mcpServers", () => {
    const config = asConfig({
      plugins: {
        entries: {
          noConfig: {},
          noMcpServers: { config: { otherKey: "value" } },
          noEnv: { config: { mcpServers: { s1: { command: "x" } } } },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
  });

  it("skips when no plugins.entries at all", () => {
    const config = asConfig({});
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
  });

  it("skips assignments when plugins.enabled is false", () => {
    const config = asConfig({
      plugins: {
        enabled: false,
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
    expect(context.warnings.some((w) => w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")).toBe(
      true,
    );
  });

  it("skips assignments when entry.enabled is false", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            enabled: false,
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
    expect(context.warnings.some((w) => w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")).toBe(
      true,
    );
  });

  it("collects assignments when plugins.enabled is true and entry.enabled is not false", () => {
    const config = asConfig({
      plugins: {
        enabled: true,
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(1);
  });

  it("skips assignments when plugin is in denylist", () => {
    const config = asConfig({
      plugins: {
        deny: ["acpx"],
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
    expect(context.warnings.some((w) => w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")).toBe(
      true,
    );
  });

  it("skips assignments when allowlist is set and plugin is not in it", () => {
    const config = asConfig({
      plugins: {
        allow: ["other-plugin"],
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
    expect(context.warnings.some((w) => w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")).toBe(
      true,
    );
  });

  it("collects assignments when plugin is in allowlist", () => {
    const config = asConfig({
      plugins: {
        allow: ["acpx"],
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K: envRef("K") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(1);
  });

  it("ignores plain string env values", () => {
    const config = asConfig({
      plugins: {
        entries: {
          acpx: {
            config: {
              mcpServers: {
                s1: {
                  command: "node",
                  env: { PLAIN: "hello", ALSO_PLAIN: "world" },
                },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(0);
  });

  it("skips stale entries not in loadablePluginIds", () => {
    const config = asConfig({
      plugins: {
        entries: {
          loadable: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K1: envRef("K1") } },
              },
            },
          },
          stale: {
            config: {
              mcpServers: {
                s2: { command: "node", env: { K2: envRef("K2") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);
    const loadablePluginIds = new Set(["loadable"]);

    collectPluginConfigAssignments({ config, defaults: undefined, context, loadablePluginIds });

    // Only the loadable plugin should produce an assignment
    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]?.path).toBe(
      "plugins.entries.loadable.config.mcpServers.s1.env.K1",
    );
    // The stale entry should emit an inactive-surface warning
    expect(
      context.warnings.some(
        (w) =>
          w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
          w.path === "plugins.entries.stale.config.mcpServers.s2.env.K2",
      ),
    ).toBe(true);
  });

  it("collects all entries when loadablePluginIds is not provided", () => {
    const config = asConfig({
      plugins: {
        entries: {
          pluginA: {
            config: {
              mcpServers: {
                s1: { command: "node", env: { K1: envRef("K1") } },
              },
            },
          },
          pluginB: {
            config: {
              mcpServers: {
                s2: { command: "node", env: { K2: envRef("K2") } },
              },
            },
          },
        },
      },
    });
    const context = makeContext(config);

    // No loadablePluginIds means no filtering
    collectPluginConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments).toHaveLength(2);
  });
});
