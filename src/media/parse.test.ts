import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput", () => {
  it("detects audio_as_voice tag and strips it", () => {
    const result = splitMediaFromOutput("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("rejects absolute media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:/Users/pete/My File.png");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:/Users/pete/My File.png");
  });

  it("rejects quoted absolute media paths to prevent LFI", () => {
    const result = splitMediaFromOutput('MEDIA:"/Users/pete/My File.png"');
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe('MEDIA:"/Users/pete/My File.png"');
  });

  it("rejects tilde media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:~/Pictures/My File.png");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:~/Pictures/My File.png");
  });

  it("rejects directory traversal media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:../../etc/passwd");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:../../etc/passwd");
  });

  it("captures safe relative media paths", () => {
    const result = splitMediaFromOutput("MEDIA:./screenshots/image.png");
    expect(result.mediaUrls).toEqual(["./screenshots/image.png"]);
    expect(result.text).toBe("");
  });

  it("keeps audio_as_voice detection stable across calls", () => {
    const input = "Hello [[audio_as_voice]]";
    const first = splitMediaFromOutput(input);
    const second = splitMediaFromOutput(input);
    expect(first.audioAsVoice).toBe(true);
    expect(second.audioAsVoice).toBe(true);
  });

  it("keeps MEDIA mentions in prose", () => {
    const input = "The MEDIA: tag fails to deliver";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("parses MEDIA tags with leading whitespace", () => {
    const result = splitMediaFromOutput("  MEDIA:./screenshot.png");
    expect(result.mediaUrls).toEqual(["./screenshot.png"]);
    expect(result.text).toBe("");
  });

  describe("temp directory paths", () => {
    const tempDir = path.resolve(os.tmpdir());

    it("accepts paths under OS temp directory", () => {
      const testPath = path.join(tempDir, "tts-abc123", "voice.opus");
      const result = splitMediaFromOutput(`MEDIA:${testPath}`);
      expect(result.mediaUrls).toHaveLength(1);
      expect(result.mediaUrls?.[0]).toBe(testPath);
    });

    it.skipIf(path.sep !== "/")("accepts paths under /tmp on POSIX", () => {
      const testPath = path.join("/tmp", "tts-abc123", "voice.opus");
      const result = splitMediaFromOutput(`MEDIA:${testPath}`);
      expect(result.mediaUrls).toHaveLength(1);
      expect(result.mediaUrls?.[0]).toBe(testPath);
    });

    it("accepts nested temp directory paths", () => {
      const testPath = path.join(tempDir, "openclaw", "sessions", "audio.mp3");
      const result = splitMediaFromOutput(`MEDIA:${testPath}`);
      expect(result.mediaUrls).toHaveLength(1);
    });

    it("rejects path traversal from temp directory", () => {
      const testPath = path.join(tempDir, "..", "etc", "passwd");
      const result = splitMediaFromOutput(`MEDIA:${testPath}`);
      expect(result.mediaUrls).toBeUndefined();
    });

    it("rejects the temp directory itself (not a file)", () => {
      const result = splitMediaFromOutput(`MEDIA:${tempDir}`);
      expect(result.mediaUrls).toBeUndefined();
    });

    it("rejects absolute paths outside temp directory", () => {
      // OS-portable path outside any temp root
      const outsidePath = path.join(path.parse(tempDir).root, "outside", "file.txt");
      const result = splitMediaFromOutput(`MEDIA:${outsidePath}`);
      expect(result.mediaUrls).toBeUndefined();
    });

    it("rejects absolute paths with similar prefix but outside temp", () => {
      // e.g., /tmp-evil/file should not match /tmp
      const evilPath = `${tempDir}-evil${path.sep}malicious.sh`;
      const result = splitMediaFromOutput(`MEDIA:${evilPath}`);
      expect(result.mediaUrls).toBeUndefined();
    });
  });
});
