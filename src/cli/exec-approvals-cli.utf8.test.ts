import "./exec-approvals-cli.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as execApprovals from "../infra/exec-approvals.js";

const { localSnapshot, resetExecApprovalsCliMocks, runApprovalsCommand, runtimeErrors } =
  await import("./exec-approvals-cli.test-support.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("exec approvals UTF-8 input", () => {
  beforeEach(resetExecApprovalsCliMocks);

  it.each(["file", "stdin"] as const)(
    "rejects malformed %s bytes without replacing policy and preserves valid Unicode",
    async (source) => {
      const file = path.join(tempDirs.make("openclaw-approvals-utf8-"), "approvals.json");
      const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
      if (!originalStdin) {
        throw new Error("Expected process.stdin");
      }
      const runInput = (bytes: Buffer) => {
        fs.writeFileSync(file, bytes);
        if (source === "stdin") {
          const split = Math.max(1, bytes.indexOf(Buffer.from("合")) + 1);
          Object.defineProperty(process, "stdin", {
            configurable: true,
            value: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
          });
        }
        return runApprovalsCommand([
          "approvals",
          "set",
          ...(source === "file" ? ["--file", file] : ["--stdin"]),
        ]);
      };
      localSnapshot.file = {
        version: 1,
        agents: { main: { allowlist: [{ pattern: "/synthetic/original" }] } },
      };
      const before = structuredClone(localSnapshot);
      const update = vi.mocked(execApprovals.updateExecApprovals).mockClear();
      try {
        const malformed = Buffer.concat([
          Buffer.from('{"agents":{"main":{"allowlist":[{"pattern":"/bad/'),
          Buffer.from([0xff]),
          Buffer.from('"}]}}}'),
        ]);
        await expect(runInput(malformed)).rejects.toThrow("__exit__:1");
        expect(runtimeErrors).toEqual([
          expect.stringContaining(`Exec approvals ${source} must be valid UTF-8.`),
        ]);
        expect(update).not.toHaveBeenCalled();
        expect(localSnapshot).toEqual(before);

        const pattern = "/synthetic/合法 � 😀";
        await runInput(
          Buffer.from(
            `\uFEFF${JSON.stringify({ agents: { main: { allowlist: [{ pattern }] } } })}\r\n`,
          ),
        );
        expect(update).toHaveBeenCalledTimes(1);
        expect(localSnapshot.file.agents?.main?.allowlist?.[0]?.pattern).toBe(pattern);
      } finally {
        Object.defineProperty(process, "stdin", originalStdin);
      }
    },
  );
});
