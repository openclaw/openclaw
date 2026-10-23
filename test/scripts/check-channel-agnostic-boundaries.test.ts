import { afterAll, describe, expect, it } from "vitest";
import {
  findChannelAgnosticBoundaryViolations as scanBoundary,
  findAcpUserFacingChannelNameViolations as scanUserText,
  findChannelCoreReverseDependencyViolations as scanReverseDeps,
  findSystemMarkLiteralViolations as scanSystemMark,
} from "../../scripts/check-channel-agnostic-boundaries.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string) {
  return parser.parseSourceFile("source.ts", content);
}

function expectViolation(scan: typeof scanBoundary, source: string, reason: string, line = 1) {
  expect(scan(parseFixture(source))).toEqual([{ line, reason }]);
}

describe("check-channel-agnostic-boundaries", () => {
  it.each([
    [
      '\nif (channel === "discord") { return true; }',
      scanBoundary,
      'compares with channel id literal (channel === "discord")',
    ],
    [
      '\nconst payload = { channel: "telegram" };',
      scanBoundary,
      'assigns channel id literal to "channel" ("telegram")',
    ],
    [
      '\nexport { resolveThreadBindingIntroText } from "../discord/monitor/thread-bindings.messages.js";',
      scanReverseDeps,
      're-exports channel module "../discord/monitor/thread-bindings.messages.js"',
    ],
    [
      '\nconst line = "⚙️ Thread bindings enabled.";',
      scanSystemMark,
      'hardcoded system mark literal ("⚙️ Thread bindings enabled.")',
    ],
  ] as const)("rejects %s", (source, scan, reason) => {
    expectViolation(scan, source, reason, 2);
  });

  it("allows the platform abort utility while retaining Signal directory checks", () => {
    expect(
      scanBoundary(parseFixture('import { isAbortError } from "../../infra/abort-signal.js";')),
    ).toEqual([]);
    expectViolation(
      scanBoundary,
      'import "../signal/infra/abort-signal.js";',
      'imports channel module "../signal/infra/abort-signal.js"',
    );
  });

  it("user-facing text mode ignores channel names in import specifiers", () => {
    expect(
      scanUserText(parseFixture('import { x } from "../discord/monitor/thread-bindings.js";')),
    ).toStrictEqual([]);
  });

  it.each([
    [
      'import * as bindings from "../discord/monitor/thread-bindings.js";',
      'imports channel module "../discord/monitor/thread-bindings.js"',
    ],
    [
      'await import /* gap */ ("../discord/private.js", { with: { type: "json" } });',
      'dynamically imports channel module "../discord/private.js"',
    ],
    ['require("../telegram/private.js");', 'imports channel module "../telegram/private.js"'],
    [
      'new URL("../slack/private.js", import.meta.url);',
      'imports channel module "../slack/private.js"',
    ],
    [
      'type PrivateModule = typeof import("../signal/private.js");',
      'dynamically imports channel module "../signal/private.js"',
    ],
  ])("flags %s in protected channel-independent sources", (source, reason) => {
    expectViolation(scanBoundary, source, reason);
  });

  it("preserves source order when imports and config paths share a line", () => {
    expect(
      scanBoundary(
        parseFixture('import "../telegram/private.js"; const enabled = cfg.channels.discord;'),
      ),
    ).toEqual([
      { line: 1, reason: 'imports channel module "../telegram/private.js"' },
      { line: 1, reason: 'references config path "channels.discord"' },
    ]);
  });
});
