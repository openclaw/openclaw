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

    it("unwraps bun x behind known global options and double-dash tails", () => {
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--silent", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--cwd", "./pkg", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "x", "--", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
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
        resolveKnownPackageManagerExecInvocation(["bun", "--unknown-global-option", "x", "sh"]),
      ).toEqual({ kind: "unsafe-exec" });
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "x", "--call", "sh -c 'id'"]),
      ).toEqual({ kind: "unsafe-exec" });
    });

    it.each(["-c", "--config", "--cwd", "--env-file"])(
      "fails closed when the %s option value hides x",
      (flag) => {
        expect(
          resolveKnownPackageManagerExecInvocation(["bun", flag, "x", "sh", "-c", "id > marker"]),
        ).toEqual({ kind: "unsafe-exec" });
      },
    );

    it("still unwraps when valued options use inline values", () => {
      expect(
        resolveKnownPackageManagerExecInvocation(["bun", "--cwd=./pkg", "x", "tsx", "./run.ts"]),
      ).toEqual({ kind: "unwrapped", argv: ["tsx", "./run.ts"] });
    });
  });
});
