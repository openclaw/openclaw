import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceWorkerArgv,
  resolveWorkspaceWorkerExecArgv,
  resolveWorkspaceWorkerUrl,
} from "./workspace-worker.js";

describe("workspace worker invocation", () => {
  it.each(["memory", "skills"] as const)(
    "keeps the %s target separate from runtime flags",
    (kind) => {
      const entry = resolveWorkspaceWorkerUrl(kind);
      expect(entry.protocol).toBe("file:");
      const entryPattern = new RegExp(
        `/(?:worker/${kind}-worker-entry\\.ts|agents/workspace-${kind}\\.worker\\.js)$`,
      );
      expect(entry.pathname).toMatch(entryPattern);
      expect(resolveWorkspaceWorkerArgv(kind).at(-1)).toMatch(entryPattern);
    },
  );

  it("keeps source-host loader flags when the worker URL is compiled", () => {
    const flags = resolveWorkspaceWorkerExecArgv("memory");
    if (process.versions.bun) {
      expect(flags).toEqual(["--no-install"]);
    } else {
      expect(flags[0]).toBe("--import");
      assert.ok(flags[1], "Expected the source worker preload");
      const registration = decodeURIComponent(flags[1].replace(/^data:text\/javascript,/, ""));
      expect(registration).toContain(
        JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url))),
      );
      expect(registration).toContain("register({ tsconfig:");
      expect(registration).toContain("tsx/dist/esm/api/");
    }
  });
});
