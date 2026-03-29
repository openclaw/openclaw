import { describe, expect, test } from "vitest";
import { classifySessionKind, type SessionKind } from "../../src/gateway/session-tool-kind.js";

describe("classifySessionKind", () => {
  const alias = "agent:main:main";
  const mainKey = "main";

  test("alias and mainKey resolve to main", () => {
    expect(classifySessionKind({ key: alias, alias, mainKey })).toBe("main");
    expect(classifySessionKind({ key: "main", alias, mainKey })).toBe("main");
  });

  test("canonical agent main session key resolves to main", () => {
    expect(
      classifySessionKind({
        key: "agent:main:main",
        alias,
        mainKey,
        gatewayKind: "direct",
      }),
    ).toBe("main");
  });

  test("cron, hook, node prefixes", () => {
    expect(classifySessionKind({ key: "cron:job", alias, mainKey })).toBe("cron");
    expect(classifySessionKind({ key: "hook:x", alias, mainKey })).toBe("hook");
    expect(classifySessionKind({ key: "node-1", alias, mainKey })).toBe("node");
    expect(classifySessionKind({ key: "node:y", alias, mainKey })).toBe("node");
  });

  test("group via gatewayKind or key shape", () => {
    expect(
      classifySessionKind({
        key: "agent:main:subagent:x",
        gatewayKind: "group",
        alias,
        mainKey,
      }),
    ).toBe("group");
    expect(
      classifySessionKind({
        key: "slack:group:thread",
        gatewayKind: "direct",
        alias,
        mainKey,
      }),
    ).toBe("group");
    expect(
      classifySessionKind({
        key: "slack:channel:thread",
        gatewayKind: "direct",
        alias,
        mainKey,
      }),
    ).toBe("group");
  });

  test("arbitrary direct session is other", () => {
    expect(
      classifySessionKind({
        key: "agent:main:subagent:worker",
        gatewayKind: "direct",
        alias,
        mainKey,
      }),
    ).toBe("other");
  });

  test("table: expected SessionKind for representative keys", () => {
    const cases: Array<{ key: string; gatewayKind?: string; want: SessionKind }> = [
      { key: alias, want: "main" },
      { key: "cron:t", want: "cron" },
      { key: "agent:main:subagent:worker", gatewayKind: "direct", want: "other" },
    ];
    for (const row of cases) {
      expect(
        classifySessionKind({
          key: row.key,
          gatewayKind: row.gatewayKind,
          alias,
          mainKey,
        }),
      ).toBe(row.want);
    }
  });
});
