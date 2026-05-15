import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExecCommandAnalysisFromAuthorizationPlan,
  planCommandForAuthorization,
} from "./command-authorization/index.js";
import {
  loadShellParserParityFixtureCases,
  loadWrapperResolutionParityFixtureCases,
} from "./exec-approvals-test-helpers.js";
import { resolveCommandResolutionFromArgv } from "./exec-approvals.js";

describe("exec approvals shell parser parity fixture", () => {
  const fixtures = loadShellParserParityFixtureCases();

  it.each(fixtures)("matches fixture: $id", async (fixture) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: fixture.command,
    });
    const res = createExecCommandAnalysisFromAuthorizationPlan({ plan });
    const ok = plan.kind === "analyzable" && Boolean(res?.ok);
    expect(ok).toBe(fixture.ok);
    if (fixture.ok) {
      const executables = res?.segments.map((segment) =>
        path.basename(segment.argv[0] ?? "").toLowerCase(),
      );
      expect(executables).toEqual(fixture.executables.map((entry) => entry.toLowerCase()));
    } else {
      expect(plan.kind).not.toBe("analyzable");
    }
  });
});

describe("exec approvals wrapper resolution parity fixture", () => {
  const fixtures = loadWrapperResolutionParityFixtureCases();

  it.each(fixtures)("matches wrapper fixture: $id", (fixture) => {
    const resolution = resolveCommandResolutionFromArgv(fixture.argv);
    expect(resolution?.execution.rawExecutable ?? null).toBe(fixture.expectedRawExecutable);
  });
});
