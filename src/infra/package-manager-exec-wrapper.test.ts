// Tests package-manager exec wrapper resolution for inner-command approval binding.
import { describe, expect, it } from "vitest";
import { resolveKnownPackageManagerExecInvocation } from "./package-manager-exec-wrapper.js";

describe("resolveKnownPackageManagerExecInvocation", () => {
  describe("bun", () => {
    it("unwraps bun x to the inner command with bunx parity", () => {
      expect(resolveKnownPackageManagerExecInvocation(["bun", "x", "tsx", "./run.ts"])).toEqual({
        kind: "unwrapped",
        argv: ["tsx", "./run.ts"],
      });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "x", "tsx", "./run.ts"])).toEqual(
        resolveKnownPackageManagerExecInvocation(["bunx", "tsx", "./run.ts"]),
      );
    });

    it("unwraps bun x when the dispatch selector picks x", () => {
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--silent", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--cwd=./pkg", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "x", "--", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "", "x", "tsx", "./run.ts"])).toEqual(
        { kind: "unwrapped", argv: ["tsx", "./run.ts"] },
      );
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--foo=bar", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
    });

    it.each(["-c", "--config", "--cwd", "--env-file"])(
      "fails closed when dispatch after the space-valued global %s is model-dependent",
      (flag) => {
        // A literal "x" in value position is the subcommand under one
        // dispatch model and the option value under the other.
        expect(
          resolveKnownPackageManagerExecInvocation(["bun", flag, "x", "sh", "-c", "id > marker"]),
        ).toEqual({ kind: "unsafe-exec" });
        // Consuming the value selects "x"; skipping dash tokens selects the
        // value token instead.
        expect(
          resolveKnownPackageManagerExecInvocation(["bun", flag, "./pkg", "x", "tsx", "./run.ts"]),
        ).toEqual({ kind: "unsafe-exec" });
      },
    );

    it("fails closed on unknown globals only when x can be selected", () => {
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--unknown-global-option", "x", "sh"]),
      ).toEqual({ kind: "unsafe-exec" });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--unknown-global-option", "run", "dev"]),
      ).toEqual({ kind: "not-exec" });
    });

    it("keeps non-exec bun invocations out of unwrapping", () => {
      expect(resolveKnownPackageManagerExecInvocation(["bun", "run", "build"])).toEqual({
        kind: "not-exec",
      });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "./x.ts"])).toEqual({
        kind: "not-exec",
      });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "install"])).toEqual({
        kind: "not-exec",
      });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "exec", "echo ok"])).toEqual({
        kind: "not-exec",
      });
    });

    it("fails closed on ambiguous bun x forms", () => {
      expect(resolveKnownPackageManagerExecInvocation(["bun", "x"])).toEqual({
        kind: "unsafe-exec",
      });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "x", "--call", "sh -c 'id'"]),
      ).toEqual({ kind: "unsafe-exec" });
      expect(resolveKnownPackageManagerExecInvocation(["bun", "--", "x", "tsx"])).toEqual({
        kind: "unsafe-exec",
      });
    });
  });
});
