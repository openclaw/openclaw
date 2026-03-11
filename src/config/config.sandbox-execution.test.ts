import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "../agents/sandbox.js";
import type { OpenClawConfig } from "./config.js";
import { validateConfigObject } from "./config.js";

describe("sandbox execution config", () => {
  it("accepts execution policy config and preserves explicit empty allowlists", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            execution: {
              template: "python-research-v1",
              imports: {
                allow: [],
                deny: ["os"],
              },
              dependencies: {
                allow: ["numpy"],
                deny: ["requests"],
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.execution?.imports?.allow).toEqual([]);
      expect(res.config.agents?.defaults?.sandbox?.execution?.dependencies?.allow).toEqual([
        "numpy",
      ]);
    }
  });

  it("rejects overlapping allow and deny names", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            execution: {
              imports: {
                allow: ["math"],
                deny: ["math"],
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("uses agent override precedence for execution policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            execution: {
              imports: {
                allow: ["math"],
                deny: ["os"],
              },
              dependencies: {
                allow: ["numpy"],
                deny: ["requests"],
              },
            },
          },
        },
        list: [
          {
            id: "research",
            sandbox: {
              execution: {
                imports: {
                  allow: ["json"],
                  deny: ["sys"],
                },
              },
            },
          },
        ],
      },
    };

    const resolved = resolveSandboxConfigForAgent(cfg, "research");
    expect(resolved.execution.imports.allow).toEqual(["json"]);
    expect(resolved.execution.imports.deny).toEqual(["sys"]);
    expect(resolved.execution.dependencies.allow).toEqual(["numpy"]);
    expect(resolved.execution.dependencies.deny).toEqual(["requests"]);
  });

  it("ignores agent execution overrides under shared scope", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "shared",
            execution: {
              imports: {
                allow: ["math"],
                deny: ["os"],
              },
            },
          },
        },
        list: [
          {
            id: "research",
            sandbox: {
              execution: {
                imports: {
                  allow: ["json"],
                  deny: ["sys"],
                },
              },
            },
          },
        ],
      },
    };

    const resolved = resolveSandboxConfigForAgent(cfg, "research");
    expect(resolved.execution.imports.allow).toEqual(["math"]);
    expect(resolved.execution.imports.deny).toEqual(["os"]);
  });
});
