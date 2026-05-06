import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { assertLocalMediaAllowed } from "./local-media-access.js";

describe("assertLocalMediaAllowed", () => {
  it("allows managed inbound media paths before explicit root checks", async () => {
    const stateDir = resolveStateDir();
    const id = `managed-local-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const stateDir = resolveStateDir();
    const filePath = path.join(stateDir, "media", "inbound", "nested", "hidden.png");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("includes the configured allowed roots in the path-not-allowed error message", async () => {
    // Regression: the previous error message was just
    //   `Local media path is not under an allowed directory: <path>`
    // which gave operators no way to tell which roots WERE allowed when
    // they got the rejection (e.g. /tmp paths were silently rejected
    // without any hint that /root/.openclaw/media/inbound was the
    // expected destination). The error must now include a short hint
    // listing the configured roots so the operator can self-correct.
    const allowedRoot = path.join("/tmp", `openclaw-test-allowed-${Date.now()}`);
    await fs.mkdir(allowedRoot, { recursive: true });
    try {
      const rejectedPath = "/var/some/other/place/file.png";
      let captured: unknown;
      try {
        await assertLocalMediaAllowed(rejectedPath, [allowedRoot]);
      } catch (err) {
        captured = err;
      }
      expect(captured).toMatchObject({ code: "path-not-allowed" });
      const message = (captured as Error).message;
      expect(message).toContain(rejectedPath);
      expect(message).toContain("allowed roots:");
      expect(message).toContain(allowedRoot);
    } finally {
      await fs.rm(allowedRoot, { recursive: true, force: true });
    }
  });

  it("caps the allowed-roots hint and surfaces an overflow marker for long lists", async () => {
    // A misconfigured config with many roots must not blow up the error
    // message; the hint truncates after a small cap and reports how many
    // additional roots were elided so the operator still knows the list
    // is non-trivial without the message becoming unreadable.
    const roots: string[] = [];
    const created: string[] = [];
    try {
      for (let i = 0; i < 7; i += 1) {
        const root = path.join("/tmp", `openclaw-test-many-roots-${Date.now()}-${i}`);
        await fs.mkdir(root, { recursive: true });
        roots.push(root);
        created.push(root);
      }
      let captured: unknown;
      try {
        await assertLocalMediaAllowed("/var/elsewhere/file.png", roots);
      } catch (err) {
        captured = err;
      }
      expect(captured).toMatchObject({ code: "path-not-allowed" });
      const message = (captured as Error).message;
      expect(message).toMatch(/\+\d+ more/);
      // Only the first few roots should be inlined.
      expect(message).toContain(roots[0]);
      // The last root must NOT be present verbatim because it should be
      // covered by the overflow marker rather than spelled out.
      expect(message).not.toContain(roots[roots.length - 1]);
    } finally {
      for (const dir of created) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });
});
