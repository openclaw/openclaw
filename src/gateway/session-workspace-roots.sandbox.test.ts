import { describe, expect, it } from "vitest";
import { resolvePreparedSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { isUnscopedSessionHostWorkspace } from "./session-workspace-roots.js";

describe("host workspace sandbox classification", () => {
  it("does not prepare unused tool policy for session rows", () => {
    let policyReads = 0;
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { sandbox: { mode: "all" } } },
      tools: {
        sandbox: {
          get tools() {
            policyReads++;
            return { allow: ["group:fs", "web_*"], deny: ["exec*"] };
          },
        },
      },
    };
    for (let i = 0; i < 20; i++) {
      expect(
        isUnscopedSessionHostWorkspace({
          cfg,
          agentId: "main",
          sessionKey: `agent:main:row-${i}`,
          entry: { spawnedCwd: "/synthetic/workspace" },
        }),
      ).toBe(false);
    }
    expect(policyReads).toBe(0);
  });

  it("matches full status across randomized policies, agents, and a mid-stream reload", () => {
    let seed = 2679;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 0x100000000) * n);
    };
    const patterns = ["group:fs", "group:runtime", "*", "web_*", "exec", "image", "view_*", "bash"];
    const list = () => Array.from({ length: next(5) }, () => patterns[next(patterns.length)]!);
    const policy = () => ({
      allow: next(3) ? list() : undefined,
      alsoAllow: next(3) ? list() : undefined,
      deny: next(3) ? list() : undefined,
    });
    const modes = ["off", "all", "non-main"] as const;
    const makeConfig = (): OpenClawConfig =>
      freezeJsonSnapshot({
        tools: { sandbox: { tools: policy() } },
        agents: {
          defaults: { sandbox: { mode: modes[next(3)] } },
          entries: Object.fromEntries(
            ["alpha", "beta"].map((id) => [
              id,
              {
                sandbox: { mode: modes[next(3)] },
                tools: { sandbox: { tools: policy() } },
              },
            ]),
          ),
        },
      });
    let cfg = makeConfig();
    let hosts = 0;
    for (let i = 0; i < 400; i++) {
      if (i % 20 === 0) {
        cfg = makeConfig();
      }
      const agentId = i % 2 ? "alpha" : "beta";
      const sessionKey = `agent:${agentId}:${next(3) ? `row-${i}` : "main"}`;
      const entry: Partial<InternalSessionEntry> = {
        spawnedCwd: "/synthetic/workspace",
        sandbox: next(4) === 0 ? "required" : undefined,
        sandboxMode: next(4) === 0 ? "off" : undefined,
      };
      const expected = !resolvePreparedSandboxRuntimeStatus({
        cfg,
        agentId,
        sessionKey,
        preparedSessionEntry: entry,
      }).sandboxed;
      expect(isUnscopedSessionHostWorkspace({ cfg, agentId, sessionKey, entry })).toBe(expected);
      hosts += Number(expected);
    }
    expect(hosts).toBeGreaterThan(0);
    expect(hosts).toBeLessThan(400);
  });
});
