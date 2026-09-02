import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGithubIssue,
  createGithubIssueAsync,
  createPrefilledGithubIssueUrl,
} from "./github-issue.js";

describe("createGithubIssue default GitHub CLI spawn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a prefilled handoff when gh is absent from PATH", async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-gh-"));
    try {
      // This test intentionally reaches the real default spawn with a private empty PATH.
      // Every positive issue-creation test injects or mocks the transport instead.
      vi.stubEnv("VITEST", undefined);
      vi.stubEnv("NODE_ENV", undefined);
      vi.stubEnv("PATH", emptyPath);
      const title = "Update failure: test";
      const body = "sanitized body";
      const fallbackUrl = createPrefilledGithubIssueUrl(title, body);

      const syncResult = createGithubIssue({ body, title, url: fallbackUrl });
      const asyncResult = await createGithubIssueAsync({ body, title, url: fallbackUrl });

      expect(syncResult).toMatchObject({ fallbackUrl, ok: false });
      expect(syncResult.ok ? "" : syncResult.message).toContain("ENOENT");
      expect(asyncResult).toMatchObject({ fallbackUrl, ok: false });
      expect(asyncResult.ok ? "" : asyncResult.message).toContain("ENOENT");
    } finally {
      await fs.rm(emptyPath, { force: true, recursive: true });
    }
  });
});
