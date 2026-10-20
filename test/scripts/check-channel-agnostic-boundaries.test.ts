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

function expectViolation(
  scan: typeof findChannelAgnosticBoundaryViolations,
  source: string,
  reason: string,
  line = 1,
) {
  expect(scan(parseFixture(source))).toEqual([{ line, reason }]);
}

describe("check-channel-agnostic-boundaries", () => {
  it.each([
    [
      "flags channel-literal comparisons",
      findChannelAgnosticBoundaryViolations,
      '\nif (channel === "discord") { return true; }',
      'compares with channel id literal (channel === "discord")',
    ],
    [
      "flags object literals with explicit channel ids",
      findChannelAgnosticBoundaryViolations,
      '\nconst payload = { channel: "telegram" };',
      'assigns channel id literal to "channel" ("telegram")',
    ],
    [
      "reverse-deps mode flags channel module re-exports",
      findChannelCoreReverseDependencyViolations,
      '\nexport { resolveThreadBindingIntroText } from "../discord/monitor/thread-bindings.messages.js";',
      're-exports channel module "../discord/monitor/thread-bindings.messages.js"',
    ],
    [
      "system-mark guard flags hardcoded gear literals",
      findSystemMarkLiteralViolations,
      '\nconst line = "⚙️ Thread bindings enabled.";',
      'hardcoded system mark literal ("⚙️ Thread bindings enabled.")',
    ],
  ] as const)("%s", (_name, scan, source, reason) => {
    expectViolation(scan, source, reason, 2);
  });

  it("allows the platform abort utility while retaining Signal directory checks", () => {
    expect(
      findChannelAgnosticBoundaryViolations(
        parseFixture('import { isAbortError } from "../../infra/abort-signal.js";'),
      ),
    ).toEqual([]);
    expectViolation(
      findChannelAgnosticBoundaryViolations,
      'import "../signal/infra/abort-signal.js";',
      'imports channel module "../signal/infra/abort-signal.js"',
    );
  });

  it("user-facing text mode ignores channel names in import specifiers", () => {
    expect(
      findAcpUserFacingChannelNameViolations(
        parseFixture('import { x } from "../discord/monitor/thread-bindings.js";'),
      ),
    ).toStrictEqual([]);
  });

  it.each([
    {
      name: "namespace thread-binding import",
      source: 'import * as bindings from "../discord/monitor/thread-bindings.js";',
      reason: 'imports channel module "../discord/monitor/thread-bindings.js"',
    },
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
    expectViolation(findChannelAgnosticBoundaryViolations, source, reason);
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
