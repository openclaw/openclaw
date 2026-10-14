// Check Channel Agnostic Boundaries tests cover check channel agnostic boundaries script behavior.
import { afterAll, describe, expect, it } from "vitest";
import {
  findChannelAgnosticBoundaryViolations,
  findAcpUserFacingChannelNameViolations,
  findChannelCoreReverseDependencyViolations,
  findSystemMarkLiteralViolations,
} from "../../scripts/check-channel-agnostic-boundaries.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string) {
  return parser.parseSourceFile("source.ts", content);
}

describe("check-channel-agnostic-boundaries", () => {
  it("flags channel-literal comparisons", () => {
    const source = `
      if (channel === "discord") {
        return true;
      }
    `;
    expect(findChannelAgnosticBoundaryViolations(parseFixture(source))).toEqual([
      {
        line: 2,
        reason: 'compares with channel id literal (channel === "discord")',
      },
    ]);
  });

  it("flags object literals with explicit channel ids", () => {
    const source = `
      const payload = { channel: "telegram" };
    `;
    expect(findChannelAgnosticBoundaryViolations(parseFixture(source))).toEqual([
      {
        line: 2,
        reason: 'assigns channel id literal to "channel" ("telegram")',
      },
    ]);
  });

  it("reverse-deps mode flags channel module re-exports", () => {
    const source = `
      export { resolveThreadBindingIntroText } from "../discord/monitor/thread-bindings.messages.js";
    `;
    expect(findChannelCoreReverseDependencyViolations(parseFixture(source))).toEqual([
      {
        line: 2,
        reason: 're-exports channel module "../discord/monitor/thread-bindings.messages.js"',
      },
    ]);
  });

  it("user-facing text mode ignores channel names in import specifiers", () => {
    const source = `
      import { x } from "../discord/monitor/thread-bindings.js";
    `;
    expect(findAcpUserFacingChannelNameViolations(parseFixture(source))).toStrictEqual([]);
  });

  it("system-mark guard flags hardcoded gear literals", () => {
    const source = `
      const line = "⚙️ Thread bindings enabled.";
    `;
    expect(findSystemMarkLiteralViolations(parseFixture(source))).toEqual([
      {
        line: 2,
        reason: 'hardcoded system mark literal ("⚙️ Thread bindings enabled.")',
      },
    ]);
  });

  it.each([
    {
      name: "commented dynamic import with attributes",
      source: 'await import /* gap */ ("../discord/private.js", { with: { type: "json" } });',
      reason: 'dynamically imports channel module "../discord/private.js"',
    },
    {
      name: "CommonJS require",
      source: 'require("../telegram/private.js");',
      reason: 'imports channel module "../telegram/private.js"',
    },
    {
      name: "import.meta URL",
      source: 'new URL("../slack/private.js", import.meta.url);',
      reason: 'imports channel module "../slack/private.js"',
    },
    {
      name: "TypeScript import type",
      source: 'type PrivateModule = typeof import("../signal/private.js");',
      reason: 'dynamically imports channel module "../signal/private.js"',
    },
  ])("flags $name in protected channel-independent sources", ({ source, reason }) => {
    expect(findChannelAgnosticBoundaryViolations(parseFixture(source))).toEqual([
      { line: 1, reason },
    ]);
  });

  it("preserves source order when imports and config paths share a line", () => {
    expect(
      findChannelAgnosticBoundaryViolations(
        parseFixture('import "../telegram/private.js"; const enabled = cfg.channels.discord;'),
      ),
    ).toEqual([
      { line: 1, reason: 'imports channel module "../telegram/private.js"' },
      { line: 1, reason: 'references config path "channels.discord"' },
    ]);
  });
});
