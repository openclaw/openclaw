import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistSessionTranscriptTurn, replaceSessionEntry } from "./session-accessor.js";
import { redactUngroundedMediaRefs } from "./transcript-grounding.js";

// User-visible replacement artifact; the literal is the contract under test.
const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";
import { readRecentUserAssistantTextForSession } from "./transcript.js";

describe("redactUngroundedMediaRefs", () => {
  const mediaDir = "/managed/state/media";
  const never = () => false;

  it("redacts a fabricated managed-media path and keeps the prose", () => {
    const text = `IMAGE:${mediaDir}/whats-app-image-2026-07-06-909898742550877-194.jpg That's a serious setup, Ally.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir, exists: never });
    expect(redacted).toBe(`IMAGE:${UNGROUNDED_MEDIA_PLACEHOLDER} That's a serious setup, Ally.`);
  });

  it("keeps managed-media paths that resolve to real files", () => {
    const real = `${mediaDir}/inbound/photo.jpg`;
    const text = `See ${real} for the original.`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir,
      exists: (candidate) => candidate === real,
    });
    expect(redacted).toBe(text);
  });

  it("never touches absolute paths outside the managed media dir", () => {
    const text = "The bug is in /Users/alex/git/openclaw/src/missing-file.ts and /tmp/foo.log.";
    expect(redactUngroundedMediaRefs(text, { mediaDir, exists: never })).toBe(text);
  });

  it("returns the same reference when nothing needs redacting", () => {
    const text = "No paths here.";
    expect(redactUngroundedMediaRefs(text, { mediaDir, exists: never })).toBe(text);
  });

  it("handles the macOS /private twin of a /var media dir", () => {
    const varDir = "/var/state/media";
    const text = `Saved to /private/var/state/media/inbound/fake.png earlier.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir: varDir, exists: never });
    expect(redacted).toBe(`Saved to ${UNGROUNDED_MEDIA_PLACEHOLDER} earlier.`);
  });

  it("leaves trailing sentence punctuation attached to the prose", () => {
    const text = `I attached ${mediaDir}/fake.png.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir, exists: never });
    expect(redacted).toBe(`I attached ${UNGROUNDED_MEDIA_PLACEHOLDER}.`);
  });

  it("treats a directory at the referenced path as ungrounded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-probe-"));
    try {
      const dirRef = path.join(tempDir, "fake-dir.jpg");
      fs.mkdirSync(dirRef);
      const realFile = path.join(tempDir, "real.jpg");
      fs.writeFileSync(realFile, "jpeg-bytes");
      const text = `dir ${dirRef} file ${realFile}`;
      // No injected probe: exercises the default regular-file check.
      expect(redactUngroundedMediaRefs(text, { mediaDir: tempDir })).toBe(
        `dir ${UNGROUNDED_MEDIA_PLACEHOLDER} file ${realFile}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats a symlink at the referenced path as ungrounded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-symlink-"));
    try {
      const realFile = path.join(tempDir, "real.jpg");
      fs.writeFileSync(realFile, "jpeg-bytes");
      const linkRef = path.join(tempDir, "link.jpg");
      fs.symlinkSync(realFile, linkRef);
      const text = `link ${linkRef} file ${realFile}`;
      // No injected probe: the default check must lstat so a symlink cannot
      // launder a fabricated ref via its target.
      expect(redactUngroundedMediaRefs(text, { mediaDir: tempDir })).toBe(
        `link ${UNGROUNDED_MEDIA_PLACEHOLDER} file ${realFile}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts Windows-spelled managed paths with backslash separators", () => {
    const winDir = "C:\\Users\\bot\\state\\media";
    const text = "IMAGE:C:\\Users\\bot\\state\\media\\fake.png looks great.";
    const redacted = redactUngroundedMediaRefs(text, { mediaDir: winDir, exists: never });
    expect(redacted).toBe(`IMAGE:${UNGROUNDED_MEDIA_PLACEHOLDER} looks great.`);
  });

  it("matches a forward-slash spelling of a backslash media dir", () => {
    const winDir = "C:\\Users\\bot\\media";
    const text = "Saved C:/Users/bot/media/fake.png just now.";
    const redacted = redactUngroundedMediaRefs(text, { mediaDir: winDir, exists: never });
    expect(redacted).toBe(`Saved ${UNGROUNDED_MEDIA_PLACEHOLDER} just now.`);
  });

  it("probes Windows tokens with their authored spelling", () => {
    const winDir = "C:\\media";
    const real = "C:\\media\\real.jpg";
    const text = `See ${real} here.`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir: winDir,
      exists: (candidate) => candidate === real,
    });
    expect(redacted).toBe(text);
  });

  it("redacts a managed token that escapes the dir via .. even when it resolves to a real file", () => {
    // Classic traversal: the token starts with the managed root but ".." walks
    // it out to /etc/passwd. exists() confirms the real file, yet containment
    // must still redact it so a fabricated ref cannot launder itself.
    const escaping = `${mediaDir}/../../etc/passwd`;
    const text = `leak ${escaping} end`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir, exists: () => true });
    expect(redacted).toBe(`leak ${UNGROUNDED_MEDIA_PLACEHOLDER} end`);
  });

  it("redacts a managed-prefixed token that traverses out to a real file on disk", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-escape-"));
    try {
      const dir = path.join(tempRoot, "media");
      fs.mkdirSync(dir);
      const outsideFile = path.join(tempRoot, "secret.jpg");
      fs.writeFileSync(outsideFile, "jpeg-bytes");
      // Prefixed by the media dir but ".." resolves back out to a sibling real
      // file (every intermediate exists so lstat actually confirms it): the
      // default probe would keep it, so containment must redact.
      const escaping = `${dir}/../secret.jpg`;
      const text = `see ${escaping} here`;
      expect(redactUngroundedMediaRefs(text, { mediaDir: dir })).toBe(
        `see ${UNGROUNDED_MEDIA_PLACEHOLDER} here`,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("redacts a ref whose intermediate directory symlink escapes the media root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-dirlink-"));
    try {
      const dir = path.join(tempRoot, "media");
      fs.mkdirSync(dir);
      const outsideDir = path.join(tempRoot, "outside");
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, "secret.jpg"), "jpeg-bytes");
      // Intermediate directory symlink UNDER the media root pointing OUTSIDE it.
      // lstat on the leaf follows this symlink to a real regular file, so the
      // lexical containment gate passes; only realpath-aware parent containment
      // catches the escape and redacts the laundered ref.
      fs.symlinkSync(outsideDir, path.join(dir, "evil"));
      const escaping = path.join(dir, "evil", "secret.jpg");
      const text = `see ${escaping} here`;
      expect(redactUngroundedMediaRefs(text, { mediaDir: dir })).toBe(
        `see ${UNGROUNDED_MEDIA_PLACEHOLDER} here`,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("grounds a real file under the media root via the default realpath probe", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-real-"));
    try {
      const realFile = path.join(tempDir, "inbound-photo.jpg");
      fs.mkdirSync(path.dirname(realFile), { recursive: true });
      fs.writeFileSync(realFile, "jpeg-bytes");
      // No injected probe: the realpath-aware default probe must keep a genuine
      // regular file under the real media root grounded (parent realpath equals
      // the root realpath, including the macOS /var -> /private/var twin).
      const text = `pic ${realFile} done`;
      expect(redactUngroundedMediaRefs(text, { mediaDir: tempDir })).toBe(text);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves an in-dir token that stays contained after normalization", () => {
    const real = `${mediaDir}/inbound/photo.jpg`;
    // A harmless "." segment still resolves inside the media dir, so a real file
    // there must remain grounded.
    const contained = `${mediaDir}/inbound/./photo.jpg`;
    const text = `pic ${contained} done`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir,
      exists: (candidate) => candidate === contained || candidate === real,
    });
    expect(redacted).toBe(text);
  });

  it("redacts every fabricated ref while keeping the verified one", () => {
    const real = `${mediaDir}/inbound/real.jpg`;
    const text = `first ${mediaDir}/a.jpg then ${real} then ${mediaDir}/b.jpg`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir,
      exists: (candidate) => candidate === real,
    });
    expect(redacted).toBe(
      `first ${UNGROUNDED_MEDIA_PLACEHOLDER} then ${real} then ${UNGROUNDED_MEDIA_PLACEHOLDER}`,
    );
  });
});

describe("readRecentUserAssistantTextForSession grounding", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("grounds assistant text on replay but never rewrites user text", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-grounding-"));
    try {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      const mediaDir = path.join(tempDir, "media");
      const realFile = path.join(mediaDir, "inbound", "real.jpg");
      fs.mkdirSync(path.dirname(realFile), { recursive: true });
      fs.writeFileSync(realFile, "jpeg-bytes");
      const fakeFile = path.join(mediaDir, "whats-app-image-909898742550877.jpg");

      const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "grounding";
      const sessionId = "grounding-session";
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId, chatType: "direct", updatedAt: 1 },
      );
      // Persist through the canonical SQLite turn writer so this proves the
      // production replay path grounds assistant text, not just the legacy
      // JSONL reader.
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          updateMode: "none",
          messages: [
            {
              message: {
                role: "user",
                timestamp: 1,
                content: [{ type: "text", text: `user mentions ${fakeFile} verbatim` }],
              },
            },
            {
              message: {
                role: "assistant",
                timestamp: 2,
                content: [
                  {
                    type: "text",
                    text: `IMAGE:${fakeFile} That's a serious setup. Original at ${realFile}.`,
                  },
                ],
              },
            },
          ],
        },
      );

      const entries = await readRecentUserAssistantTextForSession({
        sessionKey,
        storePath,
        limit: 10,
      });
      const user = entries.find((entry) => entry.role === "user");
      const assistant = entries.find((entry) => entry.role === "assistant");
      expect(user?.text).toBe(`user mentions ${fakeFile} verbatim`);
      expect(assistant?.text).toBe(
        `IMAGE:${UNGROUNDED_MEDIA_PLACEHOLDER} That's a serious setup. Original at ${realFile}.`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
