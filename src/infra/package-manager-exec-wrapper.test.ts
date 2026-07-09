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
    });

    it.each(["-c", "--config", "--cwd", "--env-file", "--unknown-global-option"])(
      "selects the token after the space-valued global %s like bun dispatch does",
      (flag) => {
        // A literal "x" in value position is what bun's selector dispatches
        // to bunx, so the tail unwraps to the inner command.
        expect(
          resolveKnownPackageManagerExecInvocation(["bun", flag, "x", "sh", "-c", "id > marker"]),
        ).toEqual({ kind: "unwrapped", argv: ["sh", "-c", "id > marker"] });
        // A non-"x" token after the global is the selected command (bun runs
        // it as an ordinary invocation), so no package-exec unwrapping.
        expect(
          resolveKnownPackageManagerExecInvocation(["bun", flag, "./pkg", "x", "tsx", "./run.ts"]),
        ).toEqual({ kind: "not-exec" });
      },
    );

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
